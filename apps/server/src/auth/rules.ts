import { and, eq, isNull, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "../db/client.ts";
import {
  type Action,
  accessRules,
  actions,
  groups,
  items,
  libraries,
  serverOnlyActions,
  users,
} from "../db/schema/index.ts";
import type { AccessObject } from "./access.ts";
import { server } from "./access.ts";
import { AuthError, postgresCode } from "./errors.ts";
import { requireAdmin } from "./permissions.ts";

/** The user or Group named by an Access rule. */
export type AccessSubject = { type: "user" | "group"; id: string };

/** An Access rule with its subject and object names resolved. */
export type Rule = {
  subject: { type: "user" | "group"; id: string; name: string };
  object:
    | { type: "server"; name: "Server" }
    | { type: "library"; id: string; name: string }
    | {
        type: "item";
        id: string;
        name: string;
        kind: "movie" | "show" | "season" | "episode";
        parentId: string | null;
        showId: string | null;
      };
  action: Action;
  allowed: boolean;
};
type RuleKey = { subject: AccessSubject; object: AccessObject; action: Action };

function columns({ subject, object, action }: RuleKey) {
  if (
    object.type !== "server" &&
    (serverOnlyActions as readonly Action[]).includes(action)
  )
    throw new AuthError("INVALID_INPUT");
  return {
    userId: subject.type === "user" ? subject.id : null,
    groupId: subject.type === "group" ? subject.id : null,
    libraryId: object.type === "library" ? object.id : null,
    itemId: object.type === "item" ? object.id : null,
    action,
  };
}

/** Upserts an Access rule as an enabled built-in admin. */
export async function setRule(
  db: Database,
  actorId: string,
  input: RuleKey & { allowed: boolean },
) {
  const key = columns(input);
  await requireAdmin(db, actorId);
  try {
    await db
      .insert(accessRules)
      .values({ ...key, allowed: input.allowed })
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
  } catch (error) {
    if (postgresCode(error) === "23503") throw new AuthError("NOT_FOUND");
    throw error;
  }
}

/** Removes an Access rule, restoring inheritance, as an enabled built-in admin. */
export async function removeRule(
  db: Database,
  actorId: string,
  input: RuleKey,
) {
  const key = columns(input);
  await requireAdmin(db, actorId);
  await db
    .delete(accessRules)
    .where(
      and(
        key.userId === null
          ? isNull(accessRules.userId)
          : eq(accessRules.userId, key.userId),
        key.groupId === null
          ? isNull(accessRules.groupId)
          : eq(accessRules.groupId, key.groupId),
        key.libraryId === null
          ? isNull(accessRules.libraryId)
          : eq(accessRules.libraryId, key.libraryId),
        key.itemId === null
          ? isNull(accessRules.itemId)
          : eq(accessRules.itemId, key.itemId),
        eq(accessRules.action, key.action),
      ),
    );
}

const parent = alias(items, "parent");

// One join resolves every name a Rule carries; callers never query per rule.
async function selectRules(
  db: Pick<Database, "select">,
  where: SQL | undefined,
): Promise<Rule[]> {
  const rows = await db
    .select({
      rule: accessRules,
      userName: users.displayName,
      groupName: groups.name,
      libraryName: libraries.name,
      item: {
        id: items.id,
        title: items.title,
        kind: items.kind,
        parentId: items.parentId,
      },
      parentParentId: parent.parentId,
    })
    .from(accessRules)
    .leftJoin(users, eq(users.id, accessRules.userId))
    .leftJoin(groups, eq(groups.id, accessRules.groupId))
    .leftJoin(libraries, eq(libraries.id, accessRules.libraryId))
    .leftJoin(items, eq(items.id, accessRules.itemId))
    .leftJoin(parent, eq(parent.id, items.parentId))
    .where(where);
  return rows.flatMap(
    ({ rule, userName, groupName, libraryName, item, parentParentId }) => {
      const subject: Rule["subject"] | null = rule.userId
        ? { type: "user", id: rule.userId, name: userName ?? "" }
        : rule.groupId
          ? { type: "group", id: rule.groupId, name: groupName ?? "" }
          : null;
      if (!subject) return [];
      const object: Rule["object"] = item
        ? {
            type: "item",
            id: item.id,
            name: item.title,
            kind: item.kind,
            parentId: item.parentId,
            showId:
              item.kind === "season"
                ? item.parentId
                : item.kind === "episode"
                  ? parentParentId
                  : null,
          }
        : rule.libraryId
          ? { type: "library", id: rule.libraryId, name: libraryName ?? "" }
          : { type: "server", name: "Server" };
      return [{ subject, object, action: rule.action, allowed: rule.allowed }];
    },
  );
}

const actionOrder = new Map(actions.map((action, index) => [action, index]));
const compareNames = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "base" });

// Rules on one object sort by subject name, then by Action declaration order.
function sortWithinObject(rules: Rule[]): Rule[] {
  return rules.sort(
    (a, b) =>
      compareNames(a.subject.name, b.subject.name) ||
      (actionOrder.get(a.action) ?? 0) - (actionOrder.get(b.action) ?? 0),
  );
}

function objectWhere(object: AccessObject): SQL | undefined {
  return object.type === "server"
    ? and(isNull(accessRules.libraryId), isNull(accessRules.itemId))
    : object.type === "library"
      ? eq(accessRules.libraryId, object.id)
      : eq(accessRules.itemId, object.id);
}

const sameObject = (rule: Rule, object: AccessObject) =>
  object.type === "server"
    ? rule.object.type === "server"
    : object.type === "library"
      ? rule.object.type === "library" && rule.object.id === object.id
      : rule.object.type === "item" && rule.object.id === object.id;

// The Item's ancestor chain, nearest first, mirroring itemAccess in
// permissions.ts but loading no rules.
async function itemChain(db: Database, itemId: string) {
  const rows = await db
    .select({
      id: sql<string>`chain.id`,
      libraryId: sql<string>`chain.library_id`,
    })
    .from(
      sql`(
        with recursive ancestors as (
          select id, parent_id, library_id, 0 as depth from items where id = ${itemId}
          union all
          select parent.id, parent.parent_id, parent.library_id, child.depth + 1
          from items parent inner join ancestors child on parent.id = child.parent_id
        )
        select * from ancestors
      ) chain`,
    )
    .orderBy(sql`chain.depth`);
  if (!rows[0]) throw new AuthError("NOT_FOUND");
  return [
    ...rows.map((row) => ({ type: "item" as const, id: row.id })),
    { type: "library" as const, id: rows[0].libraryId },
    server,
  ];
}

/** Lists the Access rules on an object and the ones it inherits, as an admin. */
export async function rulesOnObject(
  db: Database,
  actorId: string,
  object: AccessObject,
): Promise<{ direct: Rule[]; inherited: Rule[] }> {
  await requireAdmin(db, actorId);
  let chain: AccessObject[];
  if (object.type === "server") {
    chain = [server];
  } else if (object.type === "library") {
    const [library] = await db
      .select({ id: libraries.id })
      .from(libraries)
      .where(eq(libraries.id, object.id));
    if (!library) throw new AuthError("NOT_FOUND");
    chain = [object, server];
  } else {
    chain = await itemChain(db, object.id);
  }
  const rules = await selectRules(db, or(...chain.map(objectWhere)));
  const [head, ...ancestors] = chain;
  if (!head) throw new AuthError("NOT_FOUND");
  return {
    direct: sortWithinObject(rules.filter((rule) => sameObject(rule, head))),
    inherited: ancestors.flatMap((parent) =>
      sortWithinObject(rules.filter((rule) => sameObject(rule, parent))),
    ),
  };
}

/** Lists every Access rule naming a user or Group, as an admin. */
export async function rulesForSubject(
  db: Database,
  actorId: string,
  subject: AccessSubject,
): Promise<Rule[]> {
  await requireAdmin(db, actorId);
  const found =
    subject.type === "user"
      ? await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, subject.id))
      : await db
          .select({ id: groups.id })
          .from(groups)
          .where(eq(groups.id, subject.id));
  if (!found[0]) throw new AuthError("NOT_FOUND");
  const rules = await selectRules(
    db,
    subject.type === "user"
      ? eq(accessRules.userId, subject.id)
      : eq(accessRules.groupId, subject.id),
  );
  const objectRank = (rule: Rule) =>
    rule.object.type === "server" ? 0 : rule.object.type === "library" ? 1 : 2;
  return rules.sort(
    (a, b) =>
      objectRank(a) - objectRank(b) ||
      compareNames(a.object.name, b.object.name) ||
      compareNames(a.subject.name, b.subject.name) ||
      (actionOrder.get(a.action) ?? 0) - (actionOrder.get(b.action) ?? 0),
  );
}
