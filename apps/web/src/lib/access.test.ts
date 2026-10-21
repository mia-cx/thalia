import { describe, expect, test } from "bun:test";
import {
  actions,
  serverOnlyActions,
} from "../../../server/src/db/schema/access.ts";
import {
  groupSummary,
  objectActions,
  objectHref,
  type Rule,
  sourceHref,
} from "./access.ts";

const item = (
  kind: "movie" | "show" | "season" | "episode",
  parentId: string | null = null,
  showId: string | null = null,
): Extract<Rule["object"], { type: "item" }> => ({
  type: "item",
  id: "item-1",
  name: "Item",
  kind,
  parentId,
  showId,
});

describe("objectActions", () => {
  test("equals the server's actions minus the server-only ones", () => {
    expect(objectActions).toEqual(
      actions.filter(
        (action) => !(serverOnlyActions as readonly string[]).includes(action),
      ),
    );
  });
});

describe("objectHref", () => {
  test("links each object type to its page", () => {
    expect(objectHref({ type: "library", id: "lib-1", name: "TV" })).toBe(
      "/web/admin/libraries/lib-1",
    );
    expect(objectHref(item("movie"))).toBe("/web/movies/item-1");
    expect(objectHref(item("show"))).toBe("/web/shows/item-1");
    expect(objectHref(item("season", "show-1", "show-1"))).toBe(
      "/web/shows/show-1/seasons/item-1",
    );
    expect(objectHref(item("episode", "season-1", "show-1"))).toBe(
      "/web/shows/show-1/seasons/season-1/episodes/item-1",
    );
  });

  test("returns null for the server and items missing a needed id", () => {
    expect(objectHref({ type: "server", name: "Server" })).toBeNull();
    expect(objectHref(item("season", null, null))).toBeNull();
    expect(objectHref(item("episode", "season-1", null))).toBeNull();
    expect(objectHref(item("episode", null, "show-1"))).toBeNull();
  });
});

describe("sourceHref", () => {
  const rule = (
    object: Rule["object"],
    type: "user" | "group" = "user",
  ): Rule =>
    ({
      subject: { type, id: "subject-1", name: "Subject" },
      object,
      action: "view",
      allowed: true,
    }) as Rule;

  test("links server rules to the subject's permissions section", () => {
    expect(rule({ type: "server", name: "Server" })).toBeDefined();
    expect(sourceHref(rule({ type: "server", name: "Server" }))).toBe(
      "/web/admin/users/subject-1#permissions",
    );
    expect(sourceHref(rule({ type: "server", name: "Server" }, "group"))).toBe(
      "/web/admin/groups/subject-1#permissions",
    );
  });

  test("links other objects to their own page", () => {
    expect(sourceHref(rule({ type: "library", id: "lib-1", name: "TV" }))).toBe(
      "/web/admin/libraries/lib-1",
    );
    expect(sourceHref(rule(item("show")))).toBe("/web/shows/item-1");
  });
});

describe("groupSummary", () => {
  const group = (
    over: Partial<{
      name: string;
      builtIn: boolean;
      server: { action: "view" | "play" | "download"; allowed: boolean }[];
      libraries: number;
      items: number;
    }>,
  ) =>
    ({
      id: "group-1",
      name: over.name ?? "Family",
      builtIn: over.builtIn ?? false,
      rules: {
        server: over.server ?? [],
        libraries: over.libraries ?? 0,
        items: over.items ?? 0,
      },
    }) as Parameters<typeof groupSummary>[0];

  test("names the built-in admins Group", () => {
    expect(groupSummary(group({ name: "admins", builtIn: true }))).toBe(
      "Can do everything",
    );
  });

  test("says No rules when the Group holds none", () => {
    expect(groupSummary(group({}))).toBe("No rules");
  });

  test("joins server allows and object counts", () => {
    expect(
      groupSummary(
        group({
          server: [
            { action: "view", allowed: true },
            { action: "play", allowed: true },
            { action: "download", allowed: true },
          ],
          libraries: 2,
          items: 1,
        }),
      ),
    ).toBe("View, Play, Download on the server · 2 Libraries · 1 Item");
  });

  test("marks a deny-only server", () => {
    expect(
      groupSummary(group({ server: [{ action: "download", allowed: false }] })),
    ).toBe("Download denied on the server");
  });

  test("mixes allows and denies on the server", () => {
    expect(
      groupSummary(
        group({
          server: [
            { action: "view", allowed: true },
            { action: "download", allowed: false },
          ],
        }),
      ),
    ).toBe("View allowed, Download denied on the server");
  });

  test("pluralises singular counts", () => {
    expect(groupSummary(group({ libraries: 1 }))).toBe("1 Library");
    expect(groupSummary(group({ items: 1 }))).toBe("1 Item");
    expect(groupSummary(group({ libraries: 2, items: 3 }))).toBe(
      "2 Libraries · 3 Items",
    );
  });
});
