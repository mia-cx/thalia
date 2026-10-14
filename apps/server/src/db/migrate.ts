import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { createDatabase, type Database } from "./client.ts";
import { accessRules, groups } from "./schema/index.ts";

/** The Postgres advisory lock migrations hold, so replicas wait for each other. */
export const migrationLockKey = 0x70656e646961n;

function migrationsFolder() {
  const candidates = [
    resolve(import.meta.dir, "../../drizzle"),
    resolve(import.meta.dir, "../drizzle"),
    resolve(dirname(process.execPath), "drizzle"),
  ];
  const folder = candidates.find((path) =>
    existsSync(resolve(path, "meta/_journal.json")),
  );
  if (!folder)
    throw new Error(
      "Migration assets are missing. Ship drizzle beside the Thalia binary.",
    );
  return folder;
}

/** Applies pending migrations and seeds built-in groups on one locked Postgres connection. */
export async function migrateDatabase(database: Database) {
  const folder = migrationsFolder();
  const connection = await database.$client.reserve();
  try {
    await connection`select pg_advisory_lock(${migrationLockKey})`;
    try {
      const db = drizzle({ client: connection });
      await migrate(db, { migrationsFolder: folder });
      await db.transaction(async (tx) => {
        await tx
          .insert(groups)
          .values({ name: "admins", builtIn: true })
          .onConflictDoNothing({ target: groups.name });
        const [usersGroup] = await tx
          .insert(groups)
          .values({ name: "users", builtIn: true })
          .onConflictDoNothing({ target: groups.name })
          .returning();
        // Only a newly seeded Group receives defaults. Upgrades preserve its existing rules.
        if (usersGroup)
          await tx.insert(accessRules).values(
            (["view", "play", "download"] as const).map((action) => ({
              groupId: usersGroup.id,
              action,
              allowed: true,
            })),
          );
      });
    } finally {
      await connection`select pg_advisory_unlock(${migrationLockKey})`;
    }
  } finally {
    connection.release();
  }
}

if (import.meta.main) {
  const database = createDatabase();
  try {
    await migrateDatabase(database.db);
  } finally {
    await database.close();
  }
}
