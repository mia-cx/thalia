import type { Action } from "../db/schema/access.ts";
import type { AccessRule, Decision } from "./access.ts";

/** Placeholder ids the case table names; a database test maps each to a real row. */
export const ids = {
  user: "user",
  group: "group",
  other: "other",
  stranger: "stranger",
  library: "library",
  item: "item",
  otherItem: "other-item",
} as const;

/** A Group `view` allow on the server unless overridden. */
export function rule(input: Partial<AccessRule>): AccessRule {
  return {
    id: Bun.randomUUIDv7(),
    userId: null,
    groupId: ids.group,
    libraryId: null,
    itemId: null,
    action: "view",
    allowed: true,
    ...input,
  };
}

/**
 * The resolver's case table. The chain runs item → library → server, and the
 * user belongs to `group` and `other`. `winner` indexes the deciding rule.
 */
export const resolverCases: {
  name: string;
  action: Action;
  rules: AccessRule[];
  allowed: boolean;
  reason: Decision["reason"];
  winner: number | null;
}[] = [
  {
    name: "item beats Library",
    action: "view",
    rules: [
      rule({ libraryId: ids.library, allowed: false }),
      rule({ itemId: ids.item }),
    ],
    allowed: true,
    reason: "rule",
    winner: 1,
  },
  {
    name: "Library beats server",
    action: "view",
    rules: [rule({}), rule({ libraryId: ids.library, allowed: false })],
    allowed: false,
    reason: "rule",
    winner: 1,
  },
  {
    name: "user beats Group on the same object",
    action: "view",
    rules: [
      rule({ libraryId: ids.library, allowed: false }),
      rule({ userId: ids.user, groupId: null, libraryId: ids.library }),
    ],
    allowed: true,
    reason: "rule",
    winner: 1,
  },
  {
    name: "deny wins between Groups",
    action: "view",
    rules: [rule({}), rule({ groupId: ids.other, allowed: false })],
    allowed: false,
    reason: "rule",
    winner: 1,
  },
  {
    name: "an unset chain is denied",
    action: "view",
    rules: [],
    allowed: false,
    reason: "unset",
    winner: null,
  },
  {
    name: "unrelated subjects and objects do not decide",
    action: "view",
    rules: [rule({ groupId: ids.stranger }), rule({ itemId: ids.otherItem })],
    allowed: false,
    reason: "unset",
    winner: null,
  },
  {
    name: "object specificity beats a user's less specific rule",
    action: "view",
    rules: [
      rule({ userId: ids.user, groupId: null, allowed: false }),
      rule({ libraryId: ids.library }),
    ],
    allowed: true,
    reason: "rule",
    winner: 1,
  },
  {
    name: "a denied view withholds play",
    action: "play",
    rules: [
      rule({ action: "play", itemId: ids.item }),
      rule({ libraryId: ids.library, allowed: false }),
    ],
    allowed: false,
    reason: "view",
    winner: 1,
  },
  {
    name: "an unset view withholds download",
    action: "download",
    rules: [rule({ action: "download", itemId: ids.item })],
    allowed: false,
    reason: "view",
    winner: null,
  },
  {
    name: "with view allowed, the Action's own rule decides",
    action: "metadata:edit",
    rules: [rule({ action: "metadata:edit", itemId: ids.item }), rule({})],
    allowed: true,
    reason: "rule",
    winner: 0,
  },
];
