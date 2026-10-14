import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import {
  type Action,
  accessRules,
  serverOnlyActions,
} from "../db/schema/index.ts";
import type { AccessObject } from "./access.ts";
import { AuthError, postgresCode } from "./errors.ts";
import { requireAdmin } from "./permissions.ts";

/** The user or Group named by an Access rule. */
export type AccessSubject = { type: "user" | "group"; id: string };
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
