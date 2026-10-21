import type { Action, accessRules } from "../db/schema/access.ts";
import { serverOnlyActions } from "../db/schema/access.ts";

/** Objects inherit Access rules from the next object in their chain. */
export type AccessObject =
  | { type: "server" }
  | { type: "library"; id: string }
  | { type: "item"; id: string };

/** The server object shared by server-wide checks. */
export const server = { type: "server" } as const;
export type AccessRule = typeof accessRules.$inferSelect;

/** A check's answer, why it was given, and the rule that decided it. */
export type Decision =
  | { allowed: boolean; reason: "rule"; rule: AccessRule }
  | { allowed: false; reason: "unset"; rule: null }
  /** The Action needs `view` on the same object; `rule` is the rule that withheld it, if any. */
  | { allowed: false; reason: "view"; rule: AccessRule | null };
type Input = {
  rules: readonly AccessRule[];
  chain: readonly AccessObject[];
  action: Action;
  userId: string;
  groupIds: readonly string[];
  /** Item ancestors are shared; each candidate copy supplies its own Library branch. */
  libraryIds?: readonly string[];
};

function decide({ rules, chain, action, userId, groupIds }: Input): Decision {
  for (const object of chain) {
    const matching = rules.filter(
      (rule) =>
        rule.action === action &&
        (rule.userId === userId ||
          (rule.groupId !== null && groupIds.includes(rule.groupId))) &&
        (object.type === "server"
          ? rule.libraryId === null && rule.itemId === null
          : object.type === "library"
            ? rule.libraryId === object.id
            : rule.itemId === object.id),
    );
    const rule =
      matching.find((rule) => rule.userId === userId) ??
      matching.find((rule) => !rule.allowed) ??
      matching[0];
    if (rule) return { allowed: rule.allowed, reason: "rule", rule };
  }
  return { allowed: false, reason: "unset", rule: null };
}

/** Resolves object specificity, subject precedence and the prerequisite to view. */
export function resolveAccess(input: Input): Decision {
  if (input.libraryIds !== undefined) {
    const items = input.chain.filter((object) => object.type === "item");
    const decisions = input.libraryIds.map((id) =>
      resolveAccess({
        ...input,
        libraryIds: undefined,
        chain: [...items, { type: "library", id }, server],
      }),
    );
    return (
      decisions.find((decision) => decision.allowed) ??
      decisions[0] ?? { allowed: false, reason: "unset", rule: null }
    );
  }
  if (
    (serverOnlyActions as readonly Action[]).includes(input.action) &&
    input.chain[0]?.type !== "server"
  )
    throw new Error("Server-only Actions require the server object.");
  if (input.action !== "view") {
    const view = decide({ ...input, action: "view" });
    if (!view.allowed)
      return { allowed: false, reason: "view", rule: view.rule };
  }
  return decide(input);
}
