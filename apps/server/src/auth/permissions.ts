import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import {
  type Action,
  accessRules,
  actions,
  groups,
  itemAncestors,
  libraries,
  serverOnlyActions,
  userGroups,
  users,
  versions,
} from "../db/schema/index.ts";
import { type AccessObject, resolveAccess, server } from "./access.ts";
import { AuthError, postgresCode } from "./errors.ts";

type Queryable = Pick<Database, "select">;

async function enabledUser(
  db: Queryable,
  userId: string,
): Promise<{ id: string } | undefined> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.disabledAt)))
    .limit(1);
  return row;
}

async function memberships(db: Queryable, userId: string) {
  return db
    .select({
      id: groups.id,
      name: groups.name,
      builtIn: groups.builtIn,
    })
    .from(userGroups)
    .innerJoin(groups, eq(groups.id, userGroups.groupId))
    .where(eq(userGroups.userId, userId));
}

/** Loads the nearest-first Item chain and every descendant Version Library, without ordering unrelated branches. */
export async function itemAccessChain(db: Queryable, itemId: string) {
  const [ancestors, branches] = await Promise.all([
    db
      .select({ id: itemAncestors.ancestorId })
      .from(itemAncestors)
      .where(eq(itemAncestors.descendantId, itemId))
      .orderBy(itemAncestors.depth),
    db
      .select({ id: versions.libraryId })
      .from(itemAncestors)
      .innerJoin(versions, eq(versions.itemId, itemAncestors.descendantId))
      .where(eq(itemAncestors.ancestorId, itemId)),
  ]);
  if (ancestors.length === 0) throw new AuthError("NOT_FOUND");
  return {
    chain: ancestors.map(({ id }): AccessObject => ({ type: "item", id })),
    libraryIds: [...new Set(branches.map(({ id }) => id))],
  };
}

async function callerRules(
  db: Queryable,
  userId: string,
  groupIds: string[],
  chain?: AccessObject[],
) {
  return db
    .select()
    .from(accessRules)
    .where(
      and(
        or(
          eq(accessRules.userId, userId),
          groupIds.length ? inArray(accessRules.groupId, groupIds) : undefined,
        ),
        chain
          ? or(
              ...chain.map((object) =>
                object.type === "server"
                  ? and(
                      isNull(accessRules.libraryId),
                      isNull(accessRules.itemId),
                    )
                  : object.type === "library"
                    ? eq(accessRules.libraryId, object.id)
                    : eq(accessRules.itemId, object.id),
              ),
            )
          : undefined,
      ),
    );
}

type VersionCandidate = Pick<
  typeof versions.$inferSelect,
  "id" | "itemId" | "libraryId"
>;

/** Preloads caller facts once; batch filters read ancestry in sets before any copy's paths or streams are loaded. */
export async function loadPermissionScope(db: Queryable, userId: string) {
  const enabled = (await enabledUser(db, userId)) !== undefined;
  const memberGroups = enabled ? await memberships(db, userId) : [];
  const admin = memberGroups.some(
    (group) => group.builtIn && group.name === "admins",
  );
  const groupIds = memberGroups.map((group) => group.id);
  const rules =
    enabled && !admin ? await callerRules(db, userId, groupIds) : [];

  const chains = async (itemIds: readonly string[]) => {
    const rows =
      itemIds.length === 0
        ? []
        : await db
            .select({
              itemId: itemAncestors.descendantId,
              id: itemAncestors.ancestorId,
            })
            .from(itemAncestors)
            .where(inArray(itemAncestors.descendantId, [...itemIds]))
            .orderBy(itemAncestors.depth);
    const byItem = new Map<string, AccessObject[]>();
    for (const row of rows) {
      const chain = byItem.get(row.itemId) ?? [];
      chain.push({ type: "item", id: row.id });
      byItem.set(row.itemId, chain);
    }
    return byItem;
  };
  const versionIds = async (
    action: Action,
    candidates: readonly VersionCandidate[],
  ) => {
    if (!enabled) return new Set<string>();
    if (admin) return new Set(candidates.map((version) => version.id));
    const ancestry = await chains([
      ...new Set(candidates.map((version) => version.itemId)),
    ]);
    return new Set(
      candidates
        .filter(
          (version) =>
            resolveAccess({
              rules,
              userId,
              groupIds,
              action,
              chain: ancestry.get(version.itemId) ?? [],
              libraryIds: [version.libraryId],
            }).allowed,
        )
        .map((version) => version.id),
    );
  };
  const itemIds = async (action: Action, ids: readonly string[]) => {
    if (!enabled || ids.length === 0) return new Set<string>();
    if (admin) return new Set(ids);
    const [ancestry, branches] = await Promise.all([
      chains(ids),
      db
        .select({
          itemId: itemAncestors.ancestorId,
          libraryId: versions.libraryId,
        })
        .from(itemAncestors)
        .innerJoin(versions, eq(versions.itemId, itemAncestors.descendantId))
        .where(inArray(itemAncestors.ancestorId, [...ids])),
    ]);
    const libraries = new Map<string, string[]>();
    for (const branch of branches) {
      const values = libraries.get(branch.itemId) ?? [];
      values.push(branch.libraryId);
      libraries.set(branch.itemId, values);
    }
    return new Set(
      ids.filter(
        (id) =>
          resolveAccess({
            rules,
            userId,
            groupIds,
            action,
            chain: ancestry.get(id) ?? [],
            libraryIds: libraries.get(id) ?? [],
          }).allowed,
      ),
    );
  };
  return { versionIds, itemIds };
}

/** The caller's preloaded Access rules, for filtering many Items or Versions at once. */
export type PermissionScope = Awaited<ReturnType<typeof loadPermissionScope>>;

/** Returns the candidate copies permitted by their own Library branch and Item rules. */
export async function permittedVersionIds(
  db: Queryable,
  userId: string,
  action: Action,
  candidates: readonly VersionCandidate[],
) {
  return (await loadPermissionScope(db, userId)).versionIds(action, candidates);
}

/** Authorizes the explicitly selected copy; an allowed sibling copy never grants this permission. */
export async function requireVersionPermission(
  db: Queryable,
  userId: string,
  action: Action,
  versionId: string,
  itemId?: string,
) {
  const [version] = await db
    .select({
      id: versions.id,
      itemId: versions.itemId,
      libraryId: versions.libraryId,
    })
    .from(versions)
    .where(
      and(
        eq(versions.id, versionId),
        itemId === undefined ? undefined : eq(versions.itemId, itemId),
      ),
    )
    .limit(1);
  if (version === undefined) throw new AuthError("NOT_FOUND");
  if (
    !(await permittedVersionIds(db, userId, action, [version])).has(version.id)
  )
    throw new AuthError("FORBIDDEN");
}

/** Checks an enabled user's Action on the given object through Access rules. */
export async function checkPermission(
  db: Queryable,
  userId: string,
  action: Action,
  object: AccessObject,
): Promise<boolean> {
  if (
    (serverOnlyActions as readonly Action[]).includes(action) &&
    object.type !== "server"
  )
    throw new Error("Server-only Actions require the server object.");
  if (!(await enabledUser(db, userId))) return false;
  const memberGroups = await memberships(db, userId);
  if (memberGroups.some((g) => g.builtIn && g.name === "admins")) return true;
  const groupIds = memberGroups.map((g) => g.id);
  const chain: AccessObject[] =
    object.type === "server" ? [server] : [object, server];
  const loaded =
    object.type === "item"
      ? {
          ...(await itemAccessChain(db, object.id)),
          rules: await callerRules(db, userId, groupIds),
        }
      : { chain, rules: await callerRules(db, userId, groupIds, chain) };
  return resolveAccess({ ...loaded, action, userId, groupIds }).allowed;
}

/** Loads the caller's rules once and resolves each Library in memory. */
export async function viewableLibraryIds(
  db: Database,
  userId: string,
): Promise<string[]> {
  if (!(await enabledUser(db, userId))) return [];
  const memberGroups = await memberships(db, userId);
  const rows = await db.select({ id: libraries.id }).from(libraries);
  if (memberGroups.some((g) => g.builtIn && g.name === "admins"))
    return rows.map((row) => row.id);
  const groupIds = memberGroups.map((g) => g.id);
  const rules = await callerRules(db, userId, groupIds);
  return rows
    .filter(
      (row) =>
        resolveAccess({
          rules,
          chain: [{ type: "library", id: row.id }, server],
          action: "view",
          userId,
          groupIds,
        }).allowed,
    )
    .map((row) => row.id);
}

/** Throws FORBIDDEN when the caller cannot perform the Action on the object. */
export async function requirePermission(
  db: Queryable,
  userId: string,
  action: Action,
  object: AccessObject,
): Promise<void> {
  if (!(await checkPermission(db, userId, action, object)))
    throw new AuthError("FORBIDDEN");
}

const builtInNames = ["admins", "users"];

/** Reports whether the user is an enabled member of the built-in admins group. */
export async function isBuiltInAdmin(
  db: Queryable,
  userId: string,
): Promise<boolean> {
  if (!(await enabledUser(db, userId))) return false;
  const memberGroups = await memberships(db, userId);
  return memberGroups.some((group) => group.builtIn && group.name === "admins");
}

/** Throws FORBIDDEN unless the user is an enabled built-in admin. */
export async function requireAdmin(
  db: Queryable,
  userId: string,
): Promise<void> {
  if (!(await isBuiltInAdmin(db, userId))) throw new AuthError("FORBIDDEN");
}

/** Creates a custom permission group; the actor must be a built-in admin. */
export async function createGroup(
  db: Database,
  actorId: string,
  input: { name: string; permissions: readonly Action[] },
) {
  await requireAdmin(db, actorId);
  const name = input.name.trim();
  if (
    !name ||
    name.length > 80 ||
    name.includes("\0") ||
    builtInNames.includes(name.toLowerCase()) ||
    input.permissions.some((p) => !(actions as readonly string[]).includes(p))
  )
    throw new AuthError("INVALID_INPUT");
  const unique = [...new Set(input.permissions)];
  try {
    return await db.transaction(async (tx) => {
      const [group] = await tx
        .insert(groups)
        .values({ name, builtIn: false })
        .returning();
      if (!group) throw new Error("Group insert returned no row.");
      if (unique.length)
        await tx.insert(accessRules).values(
          unique.map((action) => ({
            groupId: group.id,
            action,
            allowed: true,
          })),
        );
      return { ...group, permissions: unique };
    });
  } catch (error) {
    if (postgresCode(error) === "23505") throw new AuthError("CONFLICT");
    throw error;
  }
}

/** Replaces memberships as a built-in admin and preserves an enabled admin. */
export async function setUserGroups(
  db: Database,
  actorId: string,
  userId: string,
  groupIds: readonly string[],
): Promise<void> {
  const unique = [...new Set(groupIds)];
  await db.transaction(async (tx) => {
    const [admins] = await tx
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.name, "admins"), eq(groups.builtIn, true)))
      .for("update");
    if (!admins)
      throw new Error("Seeded admins group missing; run migrations first.");
    await requireAdmin(tx, actorId);
    const [target] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.disabledAt)))
      .for("update");
    if (!target) throw new AuthError("NOT_FOUND");
    if (unique.length) {
      const found = await tx
        .select({ id: groups.id })
        .from(groups)
        .where(inArray(groups.id, unique));
      if (found.length !== unique.length) throw new AuthError("NOT_FOUND");
    }
    await tx.delete(userGroups).where(eq(userGroups.userId, userId));
    if (unique.length)
      await tx
        .insert(userGroups)
        .values(unique.map((groupId) => ({ userId, groupId })));
    const [remainingAdmin] = await tx
      .select({ id: users.id })
      .from(userGroups)
      .innerJoin(users, eq(users.id, userGroups.userId))
      .where(and(eq(userGroups.groupId, admins.id), isNull(users.disabledAt)))
      .limit(1);
    if (!remainingAdmin) throw new AuthError("CONFLICT");
  });
}

/** Sets or clears a per-user permission override; the actor must be a built-in admin. */
export async function setPermissionOverride(
  db: Pick<Database, "select" | "insert" | "delete">,
  actorId: string,
  userId: string,
  permission: Action,
  allowed: boolean | null,
): Promise<void> {
  await requireAdmin(db, actorId);
  if (!(actions as readonly string[]).includes(permission))
    throw new AuthError("INVALID_INPUT");
  const [target] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!target) throw new AuthError("NOT_FOUND");
  const where = and(
    eq(accessRules.userId, userId),
    eq(accessRules.action, permission),
    isNull(accessRules.libraryId),
    isNull(accessRules.itemId),
  );
  if (allowed === null) {
    await db.delete(accessRules).where(where);
  } else {
    await db
      .insert(accessRules)
      .values({ userId, action: permission, allowed })
      .onConflictDoUpdate({
        target: [
          accessRules.userId,
          accessRules.groupId,
          accessRules.libraryId,
          accessRules.itemId,
          accessRules.action,
        ],
        set: { allowed },
      });
  }
}
