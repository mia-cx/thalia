import { describe, expect, test } from "bun:test";
import { type AccessObject, resolveAccess, server } from "./access.ts";
import { ids, resolverCases, rule } from "./access-cases.ts";

const library = { type: "library", id: ids.library } as const;
const item = { type: "item", id: ids.item } as const;
const chain = [item, library, server];

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
  test.each(resolverCases)(
    "$name",
    ({ action, rules, allowed, reason, winner }) => {
      expect(
        resolveAccess({
          rules,
          chain,
          action,
          userId: ids.user,
          groupIds: [ids.group, ids.other],
        }),
      ).toEqual({
        allowed,
        reason,
        rule: winner === null ? null : (rules[winner] ?? null),
      });
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
