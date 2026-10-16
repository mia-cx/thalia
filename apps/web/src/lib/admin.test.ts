import { describe, expect, test } from "bun:test";
import {
  adminSections,
  checkHealth,
  currentSection,
  matchSections,
  navDirection,
  personalSections,
} from "./admin.ts";

describe("matchSections", () => {
  test("matches a label substring", () => {
    expect(matchSections("lib", true).map((s) => s.id)).toEqual(["libraries"]);
  });

  test("matches a keyword", () => {
    expect(matchSections("invite", true).map((s) => s.id)).toEqual(["users"]);
  });

  test("ignores case and surrounding whitespace", () => {
    expect(matchSections("  OIDC ", true).map((s) => s.id)).toEqual([
      "general",
    ]);
  });

  test("empty query returns every section in order", () => {
    expect(matchSections("", true)).toEqual([
      ...personalSections,
      ...adminSections,
    ]);
    expect(matchSections("   ", true)).toEqual([
      ...personalSections,
      ...adminSections,
    ]);
  });

  test("viewers only see personal sections", () => {
    expect(matchSections("", false)).toEqual(personalSections);
    expect(matchSections("lib", false)).toEqual([]);
    expect(matchSections("password", false).map((s) => s.id)).toEqual([
      "account",
    ]);
  });

  test("matches the playback section by keyword", () => {
    expect(matchSections("autoplay", false).map((s) => s.id)).toEqual([
      "playback",
    ]);
  });

  test("no match returns empty", () => {
    expect(matchSections("zzz", true)).toEqual([]);
  });
});

describe("currentSection", () => {
  const at = (path: string) => currentSection(new URL(`http://x${path}`));

  test("/admin is overview", () => {
    expect(at("/admin")).toBe("overview");
  });

  test("/admin/overview is overview", () => {
    expect(at("/admin/overview")).toBe("overview");
  });

  test("nested paths count", () => {
    expect(at("/admin/users/abc")).toBe("users");
    expect(at("/admin/libraries/abc/scan")).toBe("libraries");
  });

  test("non-admin paths are undefined", () => {
    expect(at("/movies")).toBeUndefined();
  });

  test("/settings/account is account", () => {
    expect(at("/settings")).toBeUndefined();
    expect(at("/settings/account")).toBe("account");
    expect(at("/settings/account/password")).toBe("account");
    expect(at("/settings/playback")).toBe("playback");
  });
});

describe("navDirection", () => {
  test("deeper pushes", () => {
    expect(navDirection("/admin", "/admin/users")).toBe("push");
    expect(navDirection("/admin/users", "/admin/users/abc")).toBe("push");
  });

  test("shallower pops", () => {
    expect(navDirection("/admin/users/abc", "/admin/users")).toBe("pop");
    expect(navDirection("/admin/users", "/admin")).toBe("pop");
  });

  test("same depth or non-admin paths are null", () => {
    expect(navDirection("/admin/users", "/admin/groups")).toBeNull();
    expect(navDirection("/admin", "/movies")).toBeNull();
    expect(navDirection("/movies", "/admin/users")).toBeNull();
  });

  test("/settings paths push and pop like /admin ones", () => {
    expect(navDirection("/settings", "/settings/account")).toBe("push");
    expect(navDirection("/settings/account", "/settings")).toBe("pop");
    expect(navDirection("/settings", "/admin/users")).toBe("push");
    expect(navDirection("/admin/users", "/settings/account")).toBeNull();
  });
});

describe("checkHealth", () => {
  const json = (status: number) =>
    new Response("{}", {
      status,
      headers: { "content-type": "application/json" },
    });
  const transportOf = (response: Response) =>
    (async () => response) as unknown as typeof fetch;

  test("a JSON 200 is ready", async () => {
    expect(await checkHealth(transportOf(json(200)))).toBe("ready");
  });

  test("a JSON 503 is no-database", async () => {
    expect(await checkHealth(transportOf(json(503)))).toBe("no-database");
  });

  test("an HTML 502 is unreachable", async () => {
    const html = new Response("<html>bad gateway</html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    });
    expect(await checkHealth(transportOf(html))).toBe("unreachable");
  });

  test("a transport that throws a TypeError is unreachable", async () => {
    const broken = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await checkHealth(broken)).toBe("unreachable");
  });

  test("a JSON 404 is unreachable", async () => {
    expect(await checkHealth(transportOf(json(404)))).toBe("unreachable");
  });
});
