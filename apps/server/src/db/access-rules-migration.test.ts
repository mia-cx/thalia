import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { resolveAccess, server } from "../auth/access.ts";
import { insertLibraries } from "../libraries/testing.ts";
import type { Database } from "./client.ts";
import { migrateDatabase } from "./migrate.ts";
import { accessRules, actions } from "./schema/index.ts";
import { databaseUrl, withDatabase } from "./testing.ts";

async function oldSchema(db: Database) {
  const folder = await mkdtemp(join(tmpdir(), "thalia-access-migration-"));
  try {
    await cp(new URL("../../drizzle", import.meta.url).pathname, folder, {
      recursive: true,
    });
    const path = join(folder, "meta/_journal.json");
    const journal: { entries: { tag: string }[] } = await Bun.file(path).json();
    const cut = journal.entries.findIndex((entry) =>
      entry.tag.startsWith("0023_"),
    );
    if (cut < 0) throw new Error("The Access rules migration is missing.");
    journal.entries = journal.entries.slice(0, cut);
    await writeFile(path, JSON.stringify(journal));
    await migrate(db, { migrationsFolder: folder });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

const states = [null, false, true] as const;
const oldSlug = (action: string) =>
  action === "metadata:edit"
    ? "manage-metadata"
    : action === "subtitles:edit"
      ? "manage-subtitles"
      : action.endsWith(":manage")
        ? `manage-${action.split(":")[0]}`
        : action;

describe.skipIf(!databaseUrl)("Access rules migration", () => {
  test(
    "preserves the old decision matrix except ADR specificity and view prerequisites",
    () =>
      withDatabase(
        async (db) => {
          await oldSchema(db);
          const [library] = await insertLibraries(db, {
            name: "Movies",
            medium: "movies",
            rootPath: "/movies",
          });
          if (!library) throw new Error("Fixture Library missing.");
          const subjects: {
            id: string;
            groups: string[];
            grants: boolean[];
            grant: boolean;
            override: boolean | null;
            view: boolean | null;
            libraryUser: boolean | null;
            libraryGroups: (boolean | null)[];
          }[] = [];
          for (const first of [false, true])
            for (const second of [false, true])
              for (const override of states)
                for (const view of states)
                  for (const libraryUser of states)
                    for (const libraryFirst of states)
                      for (const librarySecond of states)
                        subjects.push({
                          id: Bun.randomUUIDv7(),
                          groups: [Bun.randomUUIDv7(), Bun.randomUUIDv7()],
                          grants: [first, second],
                          grant: first || second,
                          override,
                          view,
                          libraryUser,
                          libraryGroups: [libraryFirst, librarySecond],
                        });
          const users = subjects.map(
            (subject) => sql`(${subject.id}, ${subject.id}, 'Fixture', 'x')`,
          );
          await db.execute(
            sql`insert into users (id, username, display_name, password_hash) values ${sql.join(users, sql`,`)}`,
          );
          const groupRows = subjects.flatMap((subject) =>
            subject.groups.map((id, index) => {
              // Exercise both single-Group grants and their union.
              const permissions = subject.grants[index]
                ? [...actions.map(oldSlug), "view"]
                : [];
              return sql`(${id}, ${id}, ${`{${permissions.join(",")}}`}::text[])`;
            }),
          );
          await db.execute(
            sql`insert into groups (id, name, permissions) values ${sql.join(groupRows, sql`,`)}`,
          );
          await db.execute(
            sql`insert into user_groups (id, user_id, group_id) values ${sql.join(
              subjects.flatMap((subject) =>
                subject.groups.map(
                  (id) => sql`(${Bun.randomUUIDv7()}, ${subject.id}, ${id})`,
                ),
              ),
              sql`,`,
            )}`,
          );
          const overrides = subjects.flatMap((subject) =>
            actions.flatMap((action) => {
              const allowed =
                action === "view" ? subject.view : subject.override;
              return allowed === null
                ? []
                : [
                    sql`(${Bun.randomUUIDv7()}, ${subject.id}, ${oldSlug(action)}, ${allowed})`,
                  ];
            }),
          );
          await db.execute(
            sql`insert into user_permission_overrides (id, user_id, permission, allowed) values ${sql.join(overrides, sql`,`)}`,
          );
          const libraryRows = subjects.flatMap((subject) => [
            ...(subject.libraryUser === null
              ? []
              : [
                  sql`(${Bun.randomUUIDv7()}, ${library.id}, ${subject.id}, null::uuid, ${subject.libraryUser})`,
                ]),
            ...subject.libraryGroups.flatMap((allowed, index) =>
              allowed === null
                ? []
                : [
                    sql`(${Bun.randomUUIDv7()}, ${library.id}, null::uuid, ${subject.groups[index]}, ${allowed})`,
                  ],
            ),
          ]);
          await db.execute(
            sql`insert into library_access (id, library_id, user_id, group_id, allowed) values ${sql.join(libraryRows, sql`,`)}`,
          );

          // Legacy tables have independent primary keys, so their rule ids may coincide.
          const sharedId = Bun.randomUUIDv7();
          await db.execute(
            sql`update user_permission_overrides set id = ${sharedId} where id = (select id from user_permission_overrides limit 1)`,
          );
          await db.execute(
            sql`update library_access set id = ${sharedId} where id = (select id from library_access limit 1)`,
          );

          // Record the old implementation's decisions before applying the forward migration.
          const before = subjects.map((subject) => {
            const serverView = subject.view ?? subject.grant;
            const libraryRows = [
              subject.libraryUser,
              ...subject.libraryGroups,
            ].filter((value) => value !== null);
            const libraryView = libraryRows.length
              ? libraryRows.every(Boolean)
              : serverView;
            return {
              subject,
              serverView,
              libraryView,
              actionAllowed: subject.override ?? subject.grant,
            };
          });
          await migrateDatabase(db);
          const migrated = await db.select().from(accessRules);
          const changes = new Set<string>();
          for (const {
            subject,
            serverView,
            libraryView,
            actionAllowed,
          } of before) {
            const rules = migrated.filter(
              (rule) =>
                rule.userId === subject.id ||
                (rule.groupId !== null &&
                  subject.groups.includes(rule.groupId)),
            );
            for (const action of actions) {
              const objects = action.endsWith(":manage")
                ? [server]
                : [server, { type: "library" as const, id: library.id }];
              for (const object of objects) {
                const oldView =
                  object.type === "server" ? serverView : libraryView;
                const oldAllowed = action === "view" ? oldView : actionAllowed;
                const resolved = resolveAccess({
                  rules,
                  chain: object.type === "server" ? [server] : [object, server],
                  action,
                  userId: subject.id,
                  groupIds: subject.groups,
                }).allowed;
                const userWins =
                  object.type === "library" &&
                  subject.libraryUser === true &&
                  subject.libraryGroups.includes(false);
                const newView = userWins ? true : oldView;
                expect(resolved).toBe(
                  action === "view" ? newView : actionAllowed && newView,
                );
                if (resolved !== oldAllowed) {
                  if (userWins && action === "view")
                    changes.add("user allow beats Group deny on a Library");
                  else if (!newView)
                    changes.add("Actions require view on their object");
                  else
                    throw new Error(
                      `Unexpected migration difference for ${action}`,
                    );
                }
              }
            }
          }
          expect([...changes].sort()).toEqual([
            "Actions require view on their object",
            "user allow beats Group deny on a Library",
          ]);
          expect(
            await db.execute(
              sql`select column_name from information_schema.columns where table_name = 'groups' and column_name = 'permissions'`,
            ),
          ).toEqual([]);
        },
        { empty: true },
      ),
    20_000,
  );
});
