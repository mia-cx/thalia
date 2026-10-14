import { describe, expect, test } from "bun:test";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { userDto } from "../jellyfin/users.ts";
import { createLibrary } from "../libraries/service.ts";
import { server } from "./access.ts";
import { createLocalUser, setupAdmin } from "./accounts.ts";
import { setLibraryAccess } from "./admin.ts";
import { checkPermission, setPermissionOverride } from "./permissions.ts";
import { updateAccountAccess, writeClientPreference } from "./profile.ts";

describe.skipIf(!databaseUrl)("closed Jellyfin folder lists", () => {
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
