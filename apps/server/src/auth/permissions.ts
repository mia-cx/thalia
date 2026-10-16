import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import {
  type Action,
  accessRules,
  actions,
  groups,
  libraries,
  serverOnlyActions,
  userGroups,
  users,
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

// Load an Item's parent chain and the caller's rules in one recursive query.
async function itemAccess(
  db: Queryable,
  itemId: string,
  userId: string,
  groupIds: string[],
) {
  const rows = await db
    .select({
      id: sql<string>`chain.id`,
      libraryId: sql<string>`chain.library_id`,
      rule: accessRules,
    })
    .from(sql`(
      with recursive ancestors as (
        select id, parent_id, library_id, 0 as depth from items where id = ${itemId}
        union all
        select parent.id, parent.parent_id, parent.library_id, child.depth + 1
        from items parent inner join ancestors child on parent.id = child.parent_id
      )
      select * from ancestors
    ) chain`)
    .leftJoin(
      accessRules,
      and(
        or(
          eq(accessRules.userId, userId),
          groupIds.length ? inArray(accessRules.groupId, groupIds) : undefined,
        ),
        or(
          sql`${accessRules.itemId} = chain.id`,
          sql`${accessRules.libraryId} = chain.library_id`,
          and(isNull(accessRules.itemId), isNull(accessRules.libraryId)),
        ),
      ),
    )
    .orderBy(sql`chain.depth`);
  if (!rows[0]) throw new AuthError("NOT_FOUND");
  const chain: AccessObject[] = [
    ...[...new Set(rows.map((row) => row.id))].map((id) => ({
      type: "item" as const,
      id,
    })),
    { type: "library", id: rows[0].libraryId },
    server,
  ];
  const rules = [
    ...new Map(
      rows.flatMap(({ rule }) => (rule ? [[rule.id, rule] as const] : [])),
    ).values(),
  ];
  return { chain, rules };
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
      ? await itemAccess(db, object.id, userId, groupIds)
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
