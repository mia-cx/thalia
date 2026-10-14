import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import {
  type Action,
  accessRules,
  actions,
  groups,
  libraries,
  userGroups,
  userSettings,
  users,
} from "../db/schema/index.ts";
import { server } from "./access.ts";
import { AuthError } from "./errors.ts";
import { requireAdmin, requirePermission } from "./permissions.ts";

const userFields = {
  id: users.id,
  username: users.username,
  displayName: users.displayName,
  email: users.email,
  disabledAt: users.disabledAt,
  createdAt: users.createdAt,
};

const groupFields = {
  id: groups.id,
  name: groups.name,
  builtIn: groups.builtIn,
};

/** Lists every user for a caller holding users:manage. */
export async function listUsers(db: Database, actorId: string) {
  await requirePermission(db, actorId, "users:manage", server);
  return db.select(userFields).from(users).orderBy(asc(users.username));
}

/** Lists every group for a caller holding users:manage. */
export async function listGroups(db: Database, actorId: string) {
  await requirePermission(db, actorId, "users:manage", server);
  const rows = await db
    .select(groupFields)
    .from(groups)
    .orderBy(asc(groups.name));
  const rules = await db
    .select()
    .from(accessRules)
    .where(
      and(
        isNotNull(accessRules.groupId),
        isNull(accessRules.libraryId),
        isNull(accessRules.itemId),
        eq(accessRules.allowed, true),
      ),
    );
  return rows.map((group) => ({
    ...group,
    permissions:
      group.builtIn && group.name === "admins"
        ? [...actions]
        : rules
            .filter((rule) => rule.groupId === group.id)
            .map((rule) => rule.action),
  }));
}

/** Loads one user's groups, overrides, library access and settings without a caller check. */
export async function readUserAccess(
  db: Pick<Database, "select">,
  userId: string,
) {
  const [user] = await db
    .select(userFields)
    .from(users)
    .where(eq(users.id, userId));
  if (!user) throw new AuthError("NOT_FOUND");
  const membershipRows = await db
    .select({ groupId: userGroups.groupId })
    .from(userGroups)
    .where(eq(userGroups.userId, userId))
    .orderBy(asc(userGroups.groupId));
  const overrides = await db
    .select({
      permission: accessRules.action,
      allowed: accessRules.allowed,
    })
    .from(accessRules)
    .where(
      and(
        eq(accessRules.userId, userId),
        isNull(accessRules.libraryId),
        isNull(accessRules.itemId),
      ),
    )
    .orderBy(asc(accessRules.action));
  const access = await db
    .select({
      libraryId: sql<string>`${accessRules.libraryId}`,
      allowed: accessRules.allowed,
    })
    .from(accessRules)
    .where(
      and(
        eq(accessRules.userId, userId),
        isNotNull(accessRules.libraryId),
        eq(accessRules.action, "view"),
      ),
    )
    .orderBy(asc(accessRules.libraryId));
  const [stored] = await db
    .select({
      bitrateCapBps: userSettings.bitrateCapBps,
      contentRatingCeiling: userSettings.contentRatingCeiling,
    })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));
  return {
    user,
    groupIds: membershipRows.map((row) => row.groupId),
    overrides,
    libraryAccess: access,
    settings: stored ?? { bitrateCapBps: null, contentRatingCeiling: null },
  };
}

/** Loads one user's full access shape for a caller holding users:manage. */
export async function getUserAccess(
  db: Database,
  actorId: string,
  userId: string,
) {
  await requirePermission(db, actorId, "users:manage", server);
  return readUserAccess(db, userId);
}

/** Replaces a custom group's permissions; the actor must be a built-in admin. */
export async function setGroupPermissions(
  db: Database,
  actorId: string,
  groupId: string,
  input: readonly Action[],
) {
  await requireAdmin(db, actorId);
  if (
    input.some(
      (permission) => !(actions as readonly string[]).includes(permission),
    )
  )
    throw new AuthError("INVALID_INPUT");
  const selected = [...new Set(input)];
  return db.transaction(async (tx) => {
    const [group] = await tx
      .select(groupFields)
      .from(groups)
      .where(eq(groups.id, groupId))
      .for("update");
    if (!group) throw new AuthError("NOT_FOUND");
    if (group.builtIn) throw new AuthError("INVALID_INPUT");
    await tx
      .delete(accessRules)
      .where(
        and(
          eq(accessRules.groupId, groupId),
          isNull(accessRules.libraryId),
          isNull(accessRules.itemId),
        ),
      );
    if (selected.length)
      await tx
        .insert(accessRules)
        .values(selected.map((action) => ({ groupId, action, allowed: true })));
    return { ...group, permissions: selected };
  });
}

/** The largest cap the playback planner accepts, since it reads the column as a number. */
const maxBitrateCapBps = BigInt(Number.MAX_SAFE_INTEGER);

/** Writes a user's bitrate cap and content-rating ceiling for a caller holding users:manage. */
export async function writeUserSettings(
  db: Pick<Database, "select" | "insert">,
  actorId: string,
  userId: string,
  input: { bitrateCapBps: bigint | null; contentRatingCeiling: string | null },
) {
  await requirePermission(db, actorId, "users:manage", server);
  if (
    input.bitrateCapBps !== null &&
    (input.bitrateCapBps <= 0n || input.bitrateCapBps > maxBitrateCapBps)
  )
    throw new AuthError("INVALID_INPUT");
  let contentRatingCeiling: string | null = null;
  if (input.contentRatingCeiling !== null) {
    const trimmed = input.contentRatingCeiling.trim();
    if (trimmed.length === 0 || trimmed.length > 64 || trimmed.includes("\0"))
      throw new AuthError("INVALID_INPUT");
    contentRatingCeiling = trimmed;
  }
  const [target] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId));
  if (!target) throw new AuthError("NOT_FOUND");
  const [stored] = await db
    .insert(userSettings)
    .values({
      userId,
      bitrateCapBps: input.bitrateCapBps,
      contentRatingCeiling,
    })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: {
        bitrateCapBps: input.bitrateCapBps,
        contentRatingCeiling,
      },
    })
    .returning({
      bitrateCapBps: userSettings.bitrateCapBps,
      contentRatingCeiling: userSettings.contentRatingCeiling,
    });
  if (!stored) throw new Error("User settings upsert returned no row.");
  return stored;
}

/** Sets or clears one user or group access row on a library; the actor must be a built-in admin. */
export async function setLibraryAccess(
  db: Database,
  actorId: string,
  input: {
    libraryId: string;
    userId?: string;
    groupId?: string;
    allowed: boolean | null;
  },
): Promise<void> {
  await requireAdmin(db, actorId);
  const userId = input.userId;
  const groupId = input.groupId;
  if ((userId === undefined) === (groupId === undefined))
    throw new AuthError("INVALID_INPUT");
  await db.transaction(async (tx) => {
    const [library] = await tx
      .select({ id: libraries.id })
      .from(libraries)
      .where(eq(libraries.id, input.libraryId));
    if (!library) throw new AuthError("NOT_FOUND");
    const [target] =
      userId !== undefined
        ? await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, userId))
        : groupId !== undefined
          ? await tx
              .select({ id: groups.id })
              .from(groups)
              .where(eq(groups.id, groupId))
          : [];
    if (!target) throw new AuthError("NOT_FOUND");
    const subject =
      userId !== undefined
        ? eq(accessRules.userId, userId)
        : eq(accessRules.groupId, target.id);
    if (input.allowed === null) {
      await tx
        .delete(accessRules)
        .where(
          and(
            subject,
            eq(accessRules.libraryId, input.libraryId),
            eq(accessRules.action, "view"),
          ),
        );
      return;
    }
    await tx
      .insert(accessRules)
      .values({
        userId,
        groupId,
        libraryId: input.libraryId,
        action: "view",
        allowed: input.allowed,
      })
      .onConflictDoUpdate({
        target: [
          accessRules.userId,
          accessRules.groupId,
          accessRules.libraryId,
          accessRules.itemId,
          accessRules.action,
        ],
        set: { allowed: input.allowed },
      });
  });
}
