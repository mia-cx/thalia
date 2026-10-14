import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { accessRules, libraries, settings, users } from "../db/schema/index.ts";
import { AuthError } from "./errors.ts";

// This records Jellyfin's choice for future Libraries; all access decisions still use rules.
// The auth namespace prevents account-owned client preferences from changing that choice.
const settingPrefix = "auth.jellyfin.closed-folders.";
const folderRulesLockKey = 0x666f6c646572n;
type Writer = Pick<Database, "select" | "insert" | "delete" | "execute">;

/** Serializes folder policy changes and Library creation before account row locks. */
export async function lockFolderRules(db: Pick<Database, "execute">) {
  await db.execute(sql`select pg_advisory_xact_lock(${folderRulesLockKey})`);
}

/** The protected setting tracking a user's closed Jellyfin folder list. */
export const folderRuleSettingKey = (userId: string) =>
  `${settingPrefix}${userId}`;

/** Reports whether future Libraries must receive a user view deny. */
export async function hasRestrictedFolders(
  db: Pick<Database, "select">,
  userId: string,
) {
  const [row] = await db
    .select({ id: settings.id })
    .from(settings)
    .where(eq(settings.key, folderRuleSettingKey(userId)));
  return row !== undefined;
}

/** Replaces folder rules inside the caller's administrator/account transaction. */
export async function setFolderRules(
  db: Writer,
  userId: string,
  enabled: readonly string[] | "all",
) {
  const folders = await db.select({ id: libraries.id }).from(libraries);
  if (
    enabled !== "all" &&
    enabled.some((id) => !folders.some((folder) => folder.id === id))
  )
    throw new AuthError("NOT_FOUND");
  await db
    .delete(accessRules)
    .where(
      and(
        eq(accessRules.userId, userId),
        eq(accessRules.action, "view"),
        isNotNull(accessRules.libraryId),
      ),
    );
  const key = folderRuleSettingKey(userId);
  if (enabled === "all") {
    await db.delete(settings).where(eq(settings.key, key));
    return;
  }
  await db
    .insert(settings)
    .values({ key, value: true })
    .onConflictDoNothing({ target: settings.key });
  if (folders.length)
    await db.insert(accessRules).values(
      folders.map((folder) => ({
        userId,
        libraryId: folder.id,
        action: "view" as const,
        allowed: enabled.includes(folder.id),
      })),
    );
}

/** Materializes closed folder lists as deny rules inside the new Library's transaction. */
export async function initializeLibraryRules(db: Writer, libraryId: string) {
  await lockFolderRules(db);
  const restricted = await db
    .select({ userId: users.id })
    .from(settings)
    .innerJoin(
      users,
      sql`${settings.key} = ${settingPrefix} || ${users.id}::text`,
    )
    .where(sql`${settings.value} = 'true'::jsonb`)
    .for("key share", { of: users });
  if (restricted.length)
    await db.insert(accessRules).values(
      restricted.map(({ userId }) => ({
        userId,
        libraryId,
        action: "view" as const,
        allowed: false,
      })),
    );
}
