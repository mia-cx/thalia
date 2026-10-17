import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import {
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

/** Replaces user view rules for the Libraries present when a Jellyfin policy is saved. */
export async function setFolderRules(
  tx: Pick<Database, "select" | "insert" | "delete">,
  userId: string,
  enabled: readonly string[] | "all",
) {
  const folders =
    enabled === "all"
      ? []
      : await tx.select({ id: libraries.id }).from(libraries);
  if (
    enabled !== "all" &&
    enabled.some((id) => !folders.some((folder) => folder.id === id))
  )
    throw new AuthError("NOT_FOUND");
  await tx
    .delete(accessRules)
    .where(
      and(
        eq(accessRules.userId, userId),
        eq(accessRules.action, "view"),
        isNotNull(accessRules.libraryId),
      ),
    );
  if (enabled === "all" || folders.length === 0) return;
  await tx.insert(accessRules).values(
    folders.map((folder) => ({
      userId,
      libraryId: folder.id,
      action: "view" as const,
      allowed: enabled.includes(folder.id),
    })),
  );
}

/** Lists every user for a caller holding users:manage. */
export async function listUsers(db: Database, actorId: string) {
  await requirePermission(db, actorId, "users:manage", server);
  return db.select(userFields).from(users).orderBy(asc(users.username));
}

const actionOrder = new Map(actions.map((action, index) => [action, index]));

/** Lists every group with a summary of its Access rules for a caller holding users:manage. */
export async function listGroups(db: Database, actorId: string) {
  await requirePermission(db, actorId, "users:manage", server);
  const rows = await db
    .select(groupFields)
    .from(groups)
    .orderBy(asc(groups.name));
  const rules = await db
    .select()
    .from(accessRules)
    .where(isNotNull(accessRules.groupId));
  return rows.map((group) => {
    const own = rules.filter((rule) => rule.groupId === group.id);
    return {
      ...group,
      rules: {
        server: own
          .filter((rule) => rule.libraryId === null && rule.itemId === null)
          .map((rule) => ({ action: rule.action, allowed: rule.allowed }))
          .sort(
            (a, b) =>
              (actionOrder.get(a.action) ?? 0) -
              (actionOrder.get(b.action) ?? 0),
          ),
        libraries: new Set(own.flatMap((rule) => rule.libraryId ?? [])).size,
        items: new Set(own.flatMap((rule) => rule.itemId ?? [])).size,
      },
    };
  });
}

/** Loads one user's groups, library access and settings without a caller check. */
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
      preferDirectStream: userSettings.preferDirectStream,
    })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));
  return {
    user,
    groupIds: membershipRows.map((row) => row.groupId),
    libraryAccess: access,
    settings: stored ?? {
      bitrateCapBps: null,
      contentRatingCeiling: null,
      preferDirectStream: false,
    },
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

/** The largest cap the playback planner accepts, since it reads the column as a number. */
const maxBitrateCapBps = BigInt(Number.MAX_SAFE_INTEGER);

/** Writes a user's bitrate cap, content-rating ceiling and direct-stream preference for a caller holding users:manage. */
export async function writeUserSettings(
  db: Pick<Database, "select" | "insert">,
  actorId: string,
  userId: string,
  input: {
    bitrateCapBps: bigint | null;
    contentRatingCeiling: string | null;
    preferDirectStream?: boolean;
  },
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
      preferDirectStream: input.preferDirectStream ?? false,
    })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: {
        bitrateCapBps: input.bitrateCapBps,
        contentRatingCeiling,
        ...(input.preferDirectStream === undefined
          ? {}
          : { preferDirectStream: input.preferDirectStream }),
      },
    })
    .returning({
      bitrateCapBps: userSettings.bitrateCapBps,
      contentRatingCeiling: userSettings.contentRatingCeiling,
      preferDirectStream: userSettings.preferDirectStream,
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
