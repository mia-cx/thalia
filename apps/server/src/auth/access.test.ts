import { describe, expect, test } from "bun:test";
import {
  type AccessObject,
  type AccessRule,
  resolveAccess,
  server,
} from "./access.ts";

const library = { type: "library", id: "library" } as const;
const item = { type: "item", id: "item" } as const;
const chain = [item, library, server];
function rule(input: Partial<AccessRule>): AccessRule {
  return {
    id: Bun.randomUUIDv7(),
    userId: null,
    groupId: "group",
    libraryId: null,
    itemId: null,
    action: "view",
    allowed: true,
    ...input,
  };
}

describe("Version Library branches", () => {
  // Proves Library branches are existential while Item specificity and view prerequisites remain on each branch.
  const cases = [
    {
      name: "one Library allows while another denies",
      action: "view" as const,
      rules: [
        rule({ libraryId: "a" }),
        rule({ libraryId: "b", allowed: false }),
      ],
      allowed: true,
    },
    {
      name: "reversing the Libraries preserves access",
      action: "view" as const,
      rules: [
        rule({ libraryId: "b" }),
        rule({ libraryId: "a", allowed: false }),
      ],
      allowed: true,
    },
    {
      name: "unset branches deny",
      action: "view" as const,
      rules: [],
      allowed: false,
    },
    {
      name: "an Item deny hides every copy",
      action: "view" as const,
      rules: [
        rule({ libraryId: "a" }),
        rule({ itemId: item.id, allowed: false }),
      ],
      allowed: false,
    },
    {
      name: "an Item allow overrides both Library denies",
      action: "view" as const,
      rules: [
        rule({ libraryId: "a", allowed: false }),
        rule({ libraryId: "b", allowed: false }),
        rule({ itemId: item.id }),
      ],
      allowed: true,
    },
    {
      name: "view in A cannot authorize play in B",
      action: "play" as const,
      rules: [
        rule({ libraryId: "a" }),
        rule({ libraryId: "a", action: "play", allowed: false }),
        rule({ libraryId: "b", allowed: false }),
        rule({ libraryId: "b", action: "play" }),
      ],
      allowed: false,
    },
    {
      name: "direct play still needs view",
      action: "play" as const,
      rules: [rule({ itemId: item.id, action: "play" })],
      allowed: false,
    },
    {
      name: "a child exception beats its parent on every branch",
      action: "view" as const,
      rules: [
        rule({ itemId: "parent", allowed: false }),
        rule({ itemId: item.id }),
      ],
      allowed: true,
    },
  ];
  for (const row of cases)
    test(row.name, () => {
      expect(
        resolveAccess({
          chain: [item, { type: "item", id: "parent" }],
          libraryIds: ["a", "b"],
          rules: row.rules,
          action: row.action,
          userId: "user",
          groupIds: ["group"],
        }).allowed,
      ).toBe(row.allowed);
    });
});

describe("Access rule resolver", () => {
  const cases = [
    {
      name: "item beats Library",
      rules: [
        rule({ libraryId: library.id, allowed: false }),
        rule({ itemId: item.id }),
      ],
      allowed: true,
      winner: 1,
    },
    {
      name: "Library beats server",
      rules: [rule({}), rule({ libraryId: library.id, allowed: false })],
      allowed: false,
      winner: 1,
    },
    {
      name: "user beats Group on the same object",
      rules: [
        rule({ libraryId: library.id, allowed: false }),
        rule({ userId: "user", groupId: null, libraryId: library.id }),
      ],
      allowed: true,
      winner: 1,
    },
    {
      name: "deny wins between Groups",
      rules: [rule({}), rule({ groupId: "other", allowed: false })],
      allowed: false,
      winner: 1,
    },
    {
      name: "an unset chain is denied",
      rules: [],
      allowed: false,
      winner: null,
    },
    {
      name: "unrelated subjects and objects do not decide",
      rules: [rule({ groupId: "stranger" }), rule({ itemId: "other-item" })],
      allowed: false,
      winner: null,
    },
    {
      name: "object specificity beats a user's less specific rule",
      rules: [
        rule({ userId: "user", groupId: null, allowed: false }),
        rule({ libraryId: library.id }),
      ],
      allowed: true,
      winner: 1,
    },
  ];
  test.each(cases)("$name", ({ rules, allowed, winner }) => {
    expect(
      resolveAccess({
        rules,
        chain,
        action: "view",
        userId: "user",
        groupIds: ["group", "other"],
      }),
    ).toEqual({
      allowed,
      rule: winner === null ? null : (rules[winner] ?? null),
    });
  });
  test.each(["play", "download", "metadata:edit", "subtitles:edit"] as const)(
    "%s needs view on the same chain",
    (action) => {
      const deniedView = rule({ libraryId: library.id, allowed: false });
      const allowedAction = rule({ action, itemId: item.id });
      const input = {
        rules: [allowedAction, deniedView],
        chain,
        action,
        userId: "user",
        groupIds: ["group"],
      };
      expect(resolveAccess(input)).toEqual({
        allowed: false,
        rule: deniedView,
      });
      expect(resolveAccess({ ...input, rules: [allowedAction] })).toEqual({
        allowed: false,
        rule: null,
      });
      expect(
        resolveAccess({ ...input, rules: [allowedAction, rule({})] }),
      ).toEqual({ allowed: true, rule: allowedAction });
    },
  );
  test.each([library, item] satisfies AccessObject[])(
    "server-only Actions reject $type objects",
    (object) => {
      expect(() =>
        resolveAccess({
          rules: [],
          chain: [object, server],
          action: "plugins:manage",
          userId: "user",
          groupIds: [],
        }),
      ).toThrow("Server-only");
    },
  );
});
