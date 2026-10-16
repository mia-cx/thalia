import { describe, expect, test } from "bun:test";
import {
  actions,
  serverOnlyActions,
} from "../../../server/src/db/schema/access.ts";
import { objectActions, objectHref, type Rule, sourceHref } from "./access.ts";

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
      "/admin/libraries/lib-1",
    );
    expect(objectHref(item("movie"))).toBe("/movies/item-1");
    expect(objectHref(item("show"))).toBe("/shows/item-1");
    expect(objectHref(item("season", "show-1", "show-1"))).toBe(
      "/shows/show-1/seasons/item-1",
    );
    expect(objectHref(item("episode", "season-1", "show-1"))).toBe(
      "/shows/show-1/seasons/season-1/episodes/item-1",
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
      "/admin/users/subject-1#permissions",
    );
    expect(sourceHref(rule({ type: "server", name: "Server" }, "group"))).toBe(
      "/admin/groups/subject-1#permissions",
    );
  });

  test("links other objects to their own page", () => {
    expect(sourceHref(rule({ type: "library", id: "lib-1", name: "TV" }))).toBe(
      "/admin/libraries/lib-1",
    );
    expect(sourceHref(rule(item("show")))).toBe("/shows/item-1");
  });
});
