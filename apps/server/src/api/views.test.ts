import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sql";
import { authenticate, createApiKey } from "../auth/sessions.ts";
import { insertItem } from "../db/item-fixtures.ts";
import * as schema from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { runApi } from "./errors.ts";
import { listItemCards } from "./items.ts";
import { seedBrowse } from "./view-fixtures.ts";
import {
  type ItemViewQuery,
  listItemViews,
  viewableLibraries,
} from "./views.ts";

describe.skipIf(!databaseUrl)("item views", () => {
  // Proves page size and duplicate copies do not add catalogue round trips or lose empty-page totals.
  test("catalogue pages use one statement for one or many Items and empty offsets", () =>
    withDatabase(async (db) => {
      const s = await seedBrowse(db);
      await db.insert(schema.versions).values({
        itemId: s.matrix.id,
        itemKind: "movie",
        libraryId: s.films.id,
        format: "video",
        bytes: 100n,
        label: "Second copy",
      });
      const { token } = await createApiKey(db, s.admin.id, "query proof");
      const caller = await authenticate(db, token);
      const statements: string[] = [];
      const logged = drizzle({
        client: db.$client,
        schema,
        logger: {
          logQuery(query) {
            statements.push(query);
          },
        },
      });
      const queryCounts: number[][] = [];
      for (const limit of [1, 20]) {
        statements.length = 0;
        const page = await listItemViews(logged, s.admin.id, {
          libraryIds: [s.films.id],
          kinds: ["movie"],
          limit,
        });
        expect(page.total).toBe(3);
        expect(page.items.map((item) => item.title)).toEqual(
          limit === 1 ? ["Arrival"] : ["Arrival", "Heat", "The Matrix"],
        );
        expect(
          statements.filter((query) => query.includes('from "items"')),
        ).toHaveLength(1);
        const viewQueryCount = statements.length;
        statements.length = 0;
        const cards = await runApi(
          listItemCards(logged, caller, {
            libraryId: s.films.id,
            kind: "movie",
            sort: "title",
            limit,
          }),
        );
        expect(cards.items.map((item) => item.title)).toEqual(
          limit === 1 ? ["Arrival"] : ["Arrival", "Heat", "The Matrix"],
        );
        expect(
          statements.filter((query) => query.includes('from "items"')),
        ).toHaveLength(1);
        queryCounts.push([viewQueryCount, statements.length]);
      }
      expect(queryCounts[1]).toEqual(queryCounts[0]);
      for (const query of [{ offset: 99 }, { search: "absent-title" }]) {
        statements.length = 0;
        const page = await listItemViews(logged, s.admin.id, {
          libraryIds: [s.films.id],
          kinds: ["movie"],
          ...query,
        });
        expect(page.items).toEqual([]);
        expect(page.total).toBe("offset" in query ? 3 : 0);
        expect(
          statements.filter((query) => query.includes('from "items"')),
        ).toHaveLength(1);
      }
    }));

  test("filters, sorts and pages within the caller's libraries", () =>
    withDatabase(async (db) => {
      const s = await seedBrowse(db);
      const titles = async (query: ItemViewQuery, userId = s.viewer.id) => {
        const page = await listItemViews(db, userId, query);
        return {
          titles: page.items.map((item) => item.title),
          total: page.total,
        };
      };

      expect(await titles({ kinds: ["movie"] })).toEqual({
        titles: ["Arrival", "Heat", "The Matrix"],
        total: 3,
      });
      expect((await titles({ kinds: ["movie"] }, s.admin.id)).total).toBe(4);
      expect(await titles({ ids: [s.secret.id] })).toEqual({
        titles: [],
        total: 0,
      });
      expect(await titles({ libraryIds: [s.tv.id], parentId: null })).toEqual({
        titles: ["Severance"],
        total: 1,
      });
      expect(await titles({ parentId: s.seasonOne.id })).toEqual({
        titles: ["Good News About Hell", "Half Loop"],
        total: 2,
      });
      expect(
        await titles({ ancestorId: s.show.id, kinds: ["season"] }),
      ).toEqual({ titles: ["Season 1"], total: 1 });
      expect(
        (await titles({ ancestorId: s.show.id, kinds: ["episode"] })).titles,
      ).toEqual(["Good News About Hell", "Half Loop"]);
      expect((await titles({ search: "matrx" })).titles).toEqual([
        "The Matrix",
      ]);
      expect(
        await titles({
          kinds: ["movie"],
          sort: [{ by: "title", descending: true }],
          offset: 1,
          limit: 1,
        }),
      ).toEqual({ titles: ["Heat"], total: 3 });
      expect(
        (await titles({ kinds: ["movie"], sort: [{ by: "year" }] })).titles,
      ).toEqual(["Heat", "The Matrix", "Arrival"]);
      expect(
        (await titles({ kinds: ["movie", "show"], sort: [{ by: "premiere" }] }))
          .titles[0],
      ).toBe("Severance");

      await insertItem(db, {
        withVersion: true,
        libraryId: s.films.id,
        kind: "movie",
        title: "2001: A Space Odyssey",
        canonicalFolder: "2001",
        extension: {},
      });
      const movies = { kinds: ["movie" as const] };
      expect(await titles({ ...movies, nameStartsWith: "H" })).toEqual({
        titles: ["Heat"],
        total: 1,
      });
      expect((await titles({ ...movies, nameLessThan: "A" })).titles).toEqual([
        "2001: A Space Odyssey",
      ]);
      expect((await titles({ ...movies, nameLessThan: "b" })).titles).toEqual([
        "2001: A Space Odyssey",
        "Arrival",
      ]);
    }));

  test("carries medium fields, artwork, provider ids and the caller's marks", () =>
    withDatabase(async (db) => {
      const s = await seedBrowse(db);
      const byTitle = async (query: ItemViewQuery) => {
        const page = await listItemViews(db, s.viewer.id, query);
        return new Map(page.items.map((item) => [item.title, item]));
      };

      const films = await byTitle({ kinds: ["movie"] });
      expect(films.get("The Matrix")).toMatchObject({
        year: 1999,
        durationSeconds: 8160,
        providerIds: { tmdb: "603", imdb: "tt0133093" },
        artwork: { poster: s.poster.id, backdrop: null },
        marks: { positionSeconds: 600, completed: false, favourite: false },
      });
      expect(films.get("Heat")?.marks).toMatchObject({
        favourite: true,
        rating: null,
      });
      expect(films.get("Arrival")?.marks.rating).toBe(8.5);

      const episodes = await byTitle({ parentId: s.seasonOne.id });
      expect(episodes.get("Good News About Hell")).toMatchObject({
        kind: "episode",
        seasonNumber: 1,
        episodeNumber: 1,
        seasonId: s.seasonOne.id,
        premiereDate: "2022-02-18",
        show: {
          id: s.show.id,
          title: "Severance",
          artwork: { poster: s.showPoster.id },
        },
        marks: { completed: true, playCount: 1 },
      });
      const shows = await byTitle({ libraryIds: [s.tv.id], parentId: null });
      // Season 2 holds no Versions, so it is listed nowhere and not counted.
      expect(shows.get("Severance")).toMatchObject({
        childCount: 1,
        premiereDate: "2022-02-18",
      });

      const marked = async (query: ItemViewQuery) => [
        ...(await byTitle(query)).keys(),
      ];
      expect(await marked({ favourite: true })).toEqual(["Heat"]);
      expect(await marked({ resumable: true })).toEqual(["The Matrix"]);
      expect(await marked({ kinds: ["episode"], played: true })).toEqual([
        "Good News About Hell",
      ]);
      expect(await marked({ kinds: ["episode"], played: false })).toEqual([
        "Half Loop",
      ]);

      expect(
        (await viewableLibraries(db, s.viewer.id)).map((row) => row.name),
      ).toEqual(["Movies", "Shows"]);
      expect(await viewableLibraries(db, s.admin.id)).toHaveLength(3);
    }));
});
