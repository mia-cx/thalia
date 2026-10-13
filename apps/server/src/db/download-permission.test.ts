import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import type { Database } from "./client.ts";
import { migrateDatabase } from "./migrate.ts";
import { databaseUrl, withDatabase } from "./testing.ts";

const downloadMigration = "0022_download_permission";
const drizzleFolder = new URL("../../drizzle", import.meta.url).pathname;

/** Applies every migration before the download permission one. */
async function migrateBeforeDownload(db: Database) {
  const folder = await mkdtemp(join(tmpdir(), "thalia-migrations-"));
  try {
    await cp(drizzleFolder, folder, { recursive: true });
    const journalPath = join(folder, "meta/_journal.json");
    const journal: { entries: { tag: string }[] } =
      await Bun.file(journalPath).json();
    const cut = journal.entries.findIndex(
      (entry) => entry.tag === downloadMigration,
    );
    if (cut < 0) throw new Error("The download migration is missing.");
    journal.entries = journal.entries.slice(0, cut);
    await writeFile(journalPath, JSON.stringify(journal));
    await migrate(db, { migrationsFolder: folder });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

describe.skipIf(!databaseUrl)("download permission migration", () => {
  test("the 0022 migration grants download wherever play was granted", () =>
    withDatabase(
      async (db) => {
        await migrateBeforeDownload(db);
        const [playable, other, player, blocked] = await Promise.all(
          [0, 1, 2, 3].map(() => Bun.randomUUIDv7()),
        );
        await db.execute(sql`
          insert into groups (id, name, permissions) values
            (${playable}, 'watchers', array['view','play']::text[]),
            (${other}, 'browsers', array['view']::text[])`);
        await db.execute(sql`
          insert into users (id, username, display_name, password_hash) values
            (${player}, 'player', 'Player', 'x'),
            (${blocked}, 'blocked', 'Blocked', 'x')`);
        await db.execute(sql`
          insert into user_permission_overrides (id, user_id, permission, allowed) values
            (${Bun.randomUUIDv7()}, ${player}, 'play', true),
            (${Bun.randomUUIDv7()}, ${blocked}, 'play', false)`);

        await migrateDatabase(db);

        const groupRows = await db.execute<{
          name: string;
          permissions: string[];
        }>(
          sql`select name, permissions from groups where name in ('watchers', 'browsers', 'users') order by name`,
        );
        expect(groupRows).toEqual([
          { name: "browsers", permissions: ["view"] },
          { name: "users", permissions: ["view", "play", "download"] },
          { name: "watchers", permissions: ["view", "play", "download"] },
        ]);
        const overrides = await db.execute<{
          user_id: string;
          allowed: boolean;
        }>(
          sql`select user_id, allowed from user_permission_overrides where permission = 'download' order by user_id`,
        );
        expect(overrides).toEqual([{ user_id: player, allowed: true }]);
      },
      { empty: true },
    ));
});
