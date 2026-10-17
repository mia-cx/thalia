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
type Input = {
  rules: readonly AccessRule[];
  chain: readonly AccessObject[];
  action: Action;
  userId: string;
  groupIds: readonly string[];
  /** Item ancestors are shared; each candidate copy supplies its own Library branch. */
  libraryIds?: readonly string[];
};

function decide({ rules, chain, action, userId, groupIds }: Input) {
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
    if (rule) return { allowed: rule.allowed, rule };
  }
  return { allowed: false, rule: null };
}

/** Resolves object specificity, subject precedence and the prerequisite to view. */
export function resolveAccess(input: Input): {
  allowed: boolean;
  rule: AccessRule | null;
} {
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
      decisions[0] ?? { allowed: false, rule: null }
    );
  }
  if (
    (serverOnlyActions as readonly Action[]).includes(input.action) &&
    input.chain[0]?.type !== "server"
  )
    throw new Error("Server-only Actions require the server object.");
  if (input.action !== "view") {
    const view = decide({ ...input, action: "view" });
    if (!view.allowed) return view;
  }
  return decide(input);
}
