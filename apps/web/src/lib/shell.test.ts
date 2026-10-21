import { describe, expect, test } from "bun:test";
import { initials, isCurrent, isCurrentSection, navigation } from "./shell.ts";

const libraries = [
  { id: "fam", name: "Family", medium: "movies" as const },
  { id: "films", name: "Films", medium: "movies" as const },
  { id: "tv", name: "TV", medium: "shows" as const },
];

describe("shell navigation", () => {
  test("orders Search, Home, Movies, Shows, Downloads and Settings for everyone", () => {
    const nav = navigation([]);
    expect(nav.map((e) => e.label)).toEqual([
      "Search",
      "Home",
      "Movies",
      "Shows",
      "Downloads",
      "Settings",
    ]);
    expect(nav[5].href).toBe("/web/settings");
  });

  test("settings stays current on /settings and /admin paths", () => {
    const settings = navigation([]).find((e) => e.icon === "settings");
    if (!settings) throw new Error("Settings entry missing");
    for (const path of [
      "/web/settings",
      "/web/settings/account",
      "/web/admin",
      "/web/admin/users",
    ])
      expect(
        isCurrentSection(new URL(`http://x${path}`), settings, false),
      ).toBe(true);
    expect(
      isCurrentSection(new URL("http://x/web/movies"), settings, false),
    ).toBe(false);
  });

  test("lists a medium's libraries as children only with two or more, sorted by name", () => {
    const nav = navigation(libraries);
    const movies = nav.find((e) => e.label === "Movies");
    expect(movies?.children).toEqual([
      { href: "/web/movies?library=fam", label: "Family" },
      { href: "/web/movies?library=films", label: "Films" },
    ]);
    const shows = nav.find((e) => e.label === "Shows");
    expect(shows?.children).toEqual([]);
  });

  test("matches / only on the exact root", () => {
    expect(isCurrent(new URL("http://x/web/"), "/web/")).toBe(true);
    expect(isCurrent(new URL("http://x/web/movies"), "/web/")).toBe(false);
    expect(isCurrent(new URL("http://x/web/?q=a"), "/web/")).toBe(true);
  });

  test("a section is current on its path and sub-paths, filtered or not", () => {
    const section = "/web/movies";
    const child = "/web/movies?library=fam";
    expect(isCurrent(new URL("http://x/web/movies"), section)).toBe(true);
    expect(isCurrent(new URL("http://x/web/movies/abc"), section)).toBe(true);
    const filtered = new URL("http://x/web/movies?library=fam");
    expect(isCurrent(filtered, child)).toBe(true);
    expect(isCurrent(filtered, section)).toBe(true);
    expect(isCurrent(new URL("http://x/web/movies?library=other"), child)).toBe(
      false,
    );
  });

  test("a visible library child takes the highlight; hidden children leave it on the section", () => {
    const movies = navigation(libraries).find((e) => e.label === "Movies");
    if (!movies) throw new Error("Movies entry missing");
    const filtered = new URL("http://x/web/movies?library=fam");
    expect(isCurrentSection(filtered, movies, true)).toBe(false);
    expect(isCurrentSection(filtered, movies, false)).toBe(true);
    expect(isCurrentSection(new URL("http://x/web/movies"), movies, true)).toBe(
      true,
    );
  });

  test("initials take up to two letters, uppercased", () => {
    expect(initials("Mia Chen")).toBe("MC");
    expect(initials("mia")).toBe("M");
  });

  test("search is current with any query", () => {
    expect(isCurrent(new URL("http://x/web/search?q=the"), "/web/search")).toBe(
      true,
    );
    expect(isCurrent(new URL("http://x/web/search"), "/web/search")).toBe(true);
    expect(isCurrent(new URL("http://x/web/search?q=the"), "/web/")).toBe(
      false,
    );
  });
});
