import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { userDto } from "../jellyfin/users.ts";
import { createLibrary, updateLibrary } from "../libraries/service.ts";
import { server } from "./access.ts";
import { createLocalUser, setupAdmin } from "./accounts.ts";
import { setLibraryAccess } from "./admin.ts";
import { checkPermission, setPermissionOverride } from "./permissions.ts";
import { updateAccountAccess, writeClientPreference } from "./profile.ts";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

// Pause real service transactions at their first advisory-lock statement.
function observeFirstExecute(
  db: Database,
  before: (tx: Transaction) => Promise<void>,
  after: () => Promise<void>,
) {
  return new Proxy(db, {
    get(target, key) {
      if (key === "transaction")
        return <T>(run: (tx: Transaction) => Promise<T>) =>
          target.transaction(async (tx) => {
            let first = true;
            return run(
              new Proxy(tx, {
                get(transaction, property) {
                  if (property === "execute")
                    return async (
                      query: Parameters<Transaction["execute"]>[0],
                    ) => {
                      const observe = first;
                      first = false;
                      if (observe) await before(transaction);
                      const result = await transaction.execute(query);
                      if (observe) await after();
                      return result;
                    };
                  const value = Reflect.get(transaction, property);
                  return typeof value === "function"
                    ? value.bind(transaction)
                    : value;
                },
              }),
            );
          });
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe.skipIf(!databaseUrl)("closed Jellyfin folder lists", () => {
  test(
    "policy saves, Library creation and root edits complete without a lock cycle",
    () =>
      withDatabase(async (db) => {
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        const viewer = await createLocalUser(db, admin.id, {
          username: "viewer",
          password: "viewer-pass",
        });
        const existing = await createLibrary(db, admin.id, {
          name: "Existing",
          medium: "movies",
          roots: ["/existing"],
        });
        await updateAccountAccess(db, admin.id, viewer.id, {
          enabledFolders: [],
        });
        const folderHeld = Promise.withResolvers<void>();
        const continuePolicy = Promise.withResolvers<void>();
        const creatorPid = Promise.withResolvers<number>();
        const updateHasLibrary = Promise.withResolvers<void>();
        const noop = async () => {};
        const policyDb = observeFirstExecute(db, noop, async () => {
          folderHeld.resolve();
          await continuePolicy.promise;
        });
        const creationDb = observeFirstExecute(
          db,
          async (tx) => {
            const [row] = await tx.execute<{ pid: number }>(
              sql`select pg_backend_pid() as pid`,
            );
            if (!row) throw new Error("Missing transaction pid.");
            creatorPid.resolve(row.pid);
          },
          noop,
        );
        const updateDb = observeFirstExecute(
          db,
          async () => {
            updateHasLibrary.resolve();
          },
          noop,
        );
        const policy = updateAccountAccess(policyDb, admin.id, viewer.id, {
          enabledFolders: [],
        });
        await folderHeld.promise;
        const creation = createLibrary(creationDb, admin.id, {
          name: "New",
          medium: "movies",
          roots: ["/new"],
        });
        let update: ReturnType<typeof updateLibrary> | undefined;
        try {
          const pid = await creatorPid.promise;
          // Old ordering owns roots; corrected ordering waits for folders. Both have entered the lock manager.
          const deadline = Date.now() + 5_000;
          while (true) {
            const [row] = await db.execute<{ entered: boolean }>(
              sql`select exists (select 1 from pg_locks where pid = ${pid} and locktype = 'advisory') as entered`,
            );
            if (row?.entered) break;
            if (Date.now() >= deadline)
              throw new Error("Creation did not request its advisory lock.");
            await Bun.sleep(10);
          }
          update = updateLibrary(updateDb, admin.id, existing.id, {
            roots: existing.roots.map((root) => ({
              id: root.id,
              path: root.path,
            })),
          });
          const results = Promise.allSettled([policy, creation, update]);
          await Promise.race([updateHasLibrary.promise, update]);
          continuePolicy.resolve();
          const settled = await results;
          for (const result of settled)
            if (result.status === "rejected") throw result.reason;
          expect(settled.map((result) => result.status)).toEqual([
            "fulfilled",
            "fulfilled",
            "fulfilled",
          ]);
        } finally {
          continuePolicy.resolve();
          await Promise.allSettled([policy, creation, update]);
        }
      }),
    15_000,
  );
  test("an empty list denies future Libraries, restores inheritance, and preserves server rules", () =>
    withDatabase(async (db) => {
      const admin = await setupAdmin(db, {
        username: "admin",
        password: "admin-pass",
      });
      const restricted = await createLocalUser(db, admin.id, {
        username: "restricted",
        password: "restricted-pass",
      });
      const ordinary = await createLocalUser(db, admin.id, {
        username: "ordinary",
        password: "ordinary-pass",
      });
      await updateAccountAccess(db, admin.id, restricted.id, {
        enabledFolders: [],
      });
      expect(
        (await userDto(db, restricted, Bun.randomUUIDv7())).Policy,
      ).toMatchObject({ EnableAllFolders: false, EnabledFolders: [] });
      await writeClientPreference(
        db,
        restricted.id,
        restricted.id,
        "jellyfin",
        "closed-folders",
        false,
      );
      const first = await createLibrary(db, admin.id, {
        name: "First",
        medium: "movies",
        roots: ["/first"],
      });
      const object = { type: "library", id: first.id } as const;
      expect(await checkPermission(db, restricted.id, "view", object)).toBe(
        false,
      );
      expect(await checkPermission(db, ordinary.id, "view", object)).toBe(true);
      await setLibraryAccess(db, admin.id, {
        userId: ordinary.id,
        libraryId: first.id,
        allowed: false,
      });
      const second = await createLibrary(db, admin.id, {
        name: "Second",
        medium: "movies",
        roots: ["/second"],
      });
      expect(
        await checkPermission(db, ordinary.id, "view", {
          type: "library",
          id: second.id,
        }),
      ).toBe(true);
      await updateAccountAccess(db, admin.id, restricted.id, {
        enabledFolders: "all",
      });
      expect(await checkPermission(db, restricted.id, "view", object)).toBe(
        true,
      );
      await setPermissionOverride(db, admin.id, restricted.id, "view", false);
      await updateAccountAccess(db, admin.id, restricted.id, {
        enabledFolders: [],
      });
      await updateAccountAccess(db, admin.id, restricted.id, {
        enabledFolders: "all",
      });
      expect(await checkPermission(db, restricted.id, "view", server)).toBe(
        false,
      );
      expect(await checkPermission(db, restricted.id, "view", object)).toBe(
        false,
      );
    }));

  test("policy changes racing Library creation preserve the final folder mode", () =>
    withDatabase(async (db) => {
      const admin = await setupAdmin(db, {
        username: "admin",
        password: "admin-pass",
      });
      const user = await createLocalUser(db, admin.id, {
        username: "viewer",
        password: "viewer-pass",
      });
      await updateAccountAccess(db, admin.id, user.id, { enabledFolders: [] });
      for (const [index, enabledFolders] of (["all", []] as const).entries()) {
        const [, library] = await Promise.all([
          updateAccountAccess(db, admin.id, user.id, { enabledFolders }),
          createLibrary(db, admin.id, {
            name: `Concurrent ${index}`,
            medium: "movies",
            roots: [`/concurrent-${index}`],
          }),
        ]);
        expect(
          await checkPermission(db, user.id, "view", {
            type: "library",
            id: library.id,
          }),
        ).toBe(enabledFolders === "all");
      }
    }));
});
