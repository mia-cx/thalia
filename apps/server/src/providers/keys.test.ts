import { describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { items, jobs, providerIds } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { insertItem } from "../db/tree.ts";
import { createJobQueue } from "../jobs/queue.ts";
import { createJobRegistry } from "../jobs/registry.ts";
import { insertLibraries } from "../libraries/testing.ts";
import { queueProviderFetch, registerMetadataJobs } from "../metadata/jobs.ts";
import {
  tvdbEpisodePages,
  tvdbResponse,
  tvdbSeries,
} from "../metadata/tvdb-fixtures.ts";
import {
  readProviderKeyNames,
  removeProviderKey,
  setProviderKey,
} from "./keys.ts";

async function seed(db: Database) {
  const admin = await setupAdmin(db, {
    username: "admin",
    password: "admin-pass",
  });
  const viewer = await createLocalUser(db, admin.id, {
    username: "viewer",
    password: "viewer-pass",
  });
  return { admin, viewer };
}

/** A Show tree whose pending descendants share one provider fetch. */
async function seedShow(db: Database, libraryId: string) {
  const show = await insertItem(db, {
    libraryId,
    kind: "show",
    title: "Breaking Bad",
    canonicalFolder: "Breaking Bad",
    extension: {},
  });
  const season = await insertItem(db, {
    libraryId,
    kind: "season",
    parentId: show.id,
    title: "Season 1",
    canonicalFolder: "Breaking Bad/Season 01",
    extension: { seasonNumber: 1 },
  });
  const episode = await insertItem(db, {
    libraryId,
    kind: "episode",
    parentId: season.id,
    title: "Episode 1",
    canonicalFolder: "Breaking Bad/Season 01",
    extension: { episodeNumber: 1, episodeEndNumber: null },
  });
  return { show, season, episode };
}

describe.skipIf(!databaseUrl)("provider keys", () => {
  test("saving keys fetches pending movies and Show trees without a rescan or duplicate jobs", async () => {
    const previous = Bun.env.TMDB_API_KEY;
    delete Bun.env.TMDB_API_KEY;
    try {
      await withDatabase(async (db) => {
        const { admin } = await seed(db);
        const [movieLibrary, showLibrary] = await insertLibraries(db, [
          { name: "Movies", medium: "movies", rootPath: "/m" },
          { name: "Shows", medium: "shows", rootPath: "/s" },
        ]);
        if (!movieLibrary || !showLibrary)
          throw new Error("Fixture libraries missing.");
        const movie = await insertItem(db, {
          libraryId: movieLibrary.id,
          kind: "movie",
          title: "Alien",
          canonicalFolder: "Alien",
          extension: {},
        });
        const { show, season, episode } = await seedShow(db, showLibrary.id);
        await db.insert(providerIds).values([
          { itemId: movie.id, provider: "tmdb", value: "348" },
          { itemId: show.id, provider: "tvdb", value: "81189" },
        ]);
        const request = (async (
          input: RequestInfo | URL,
          init?: RequestInit,
        ) => {
          const url = new URL(String(input));
          if (url.hostname === "api.themoviedb.org")
            return Response.json({
              id: 348,
              title: "Alien",
              overview: "A movie match.",
            });
          if (url.pathname.endsWith("/extended"))
            return Response.json({
              data: {
                ...tvdbSeries,
                status: { name: "Ended" },
                image: null,
                artworks: [],
                seasons: tvdbSeries.seasons.map((entry) => ({
                  ...entry,
                  image: null,
                })),
              },
            });
          if (url.pathname.endsWith("/episodes/official"))
            return Response.json({
              data: {
                episodes: tvdbEpisodePages
                  .flat()
                  .map((entry) => ({ ...entry, image: null })),
              },
            });
          return tvdbResponse(url, init);
        }) as typeof fetch;
        const queue = createJobQueue(db);
        const registry = createJobRegistry();
        registerMetadataJobs(db, registry, request);
        const runFetches = async () => {
          for (;;) {
            const job = await queue.claim(["provider-fetch"]);
            if (!job) return;
            await registry.run(job);
            await queue.complete(job);
          }
        };
        await queueProviderFetch(db, movie.id);
        await queueProviderFetch(db, show.id);
        await runFetches();
        expect(
          (await db.select().from(items)).every(
            (item) => item.metadataState === "pending",
          ),
        ).toBe(true);
        expect(
          (await db.select().from(jobs)).every(
            (job) => job.state === "completed",
          ),
        ).toBe(true);

        const queuedFetches = () =>
          db
            .select()
            .from(jobs)
            .where(
              and(eq(jobs.type, "provider-fetch"), eq(jobs.state, "queued")),
            )
            .orderBy(jobs.id);
        await setProviderKey(db, admin.id, "tmdb", "tmdb-key");
        expect((await queuedFetches()).map((job) => job.payload)).toEqual([
          { type: "provider-fetch", itemId: movie.id },
        ]);
        await setProviderKey(db, admin.id, "tvdb", "tvdb-key");
        const queued = await queuedFetches();
        expect(queued.map((job) => job.payload)).toEqual([
          { type: "provider-fetch", itemId: movie.id },
          { type: "provider-fetch", itemId: show.id },
        ]);
        await setProviderKey(db, admin.id, "tmdb", "tmdb-key");
        await setProviderKey(db, admin.id, "tvdb", "tvdb-key");
        expect((await queuedFetches()).map((job) => job.id)).toEqual(
          queued.map((job) => job.id),
        );
        await runFetches();
        expect(
          (await db.select().from(items)).every(
            (item) => item.metadataState === "matched",
          ),
        ).toBe(true);
        const descendants = await db
          .select()
          .from(items)
          .where(inArray(items.id, [season.id, episode.id]))
          .orderBy(items.kind);
        expect(descendants.map((item) => item.title)).toEqual([
          "Season 1",
          "Pilot",
        ]);
        await setProviderKey(db, admin.id, "tmdb", "tmdb-key");
        await setProviderKey(db, admin.id, "tvdb", "tvdb-key");
        expect(await queuedFetches()).toHaveLength(0);
      });
    } finally {
      if (previous === undefined) delete Bun.env.TMDB_API_KEY;
      else Bun.env.TMDB_API_KEY = previous;
    }
  });

  for (const kind of ["season", "episode"] as const)
    test(`a pending ${kind} queues its matched Show once`, () =>
      withDatabase(async (db) => {
        const { admin } = await seed(db);
        const [library] = await insertLibraries(db, {
          name: "Shows",
          medium: "shows",
          rootPath: "/s",
        });
        if (!library) throw new Error("Fixture library missing.");
        const tree = await seedShow(db, library.id);
        await db.update(items).set({ metadataState: "matched" });
        await db
          .update(items)
          .set({ metadataState: "pending" })
          .where(eq(items.id, tree[kind].id));
        await setProviderKey(db, admin.id, "tvdb", "tvdb-key");
        await setProviderKey(db, admin.id, "tvdb", "tvdb-key");
        expect(await db.select().from(jobs)).toMatchObject([
          {
            payload: { type: "provider-fetch", itemId: tree.show.id },
            state: "queued",
          },
        ]);
      }));

  test("set, list, overwrite and remove key names only", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      expect(await readProviderKeyNames(db)).toEqual([]);
      expect(
        await setProviderKey(db, admin.id, " TMDB ", "secret-one"),
      ).toEqual(["tmdb"]);
      expect(
        await setProviderKey(db, admin.id, "OpenSubtitles", "secret-two"),
      ).toEqual(["opensubtitles", "tmdb"]);
      expect(await readProviderKeyNames(db)).toEqual(["opensubtitles", "tmdb"]);
      expect(await setProviderKey(db, admin.id, "tmdb", "rotated")).toEqual([
        "opensubtitles",
        "tmdb",
      ]);
      expect(await removeProviderKey(db, admin.id, "TMDB")).toEqual([
        "opensubtitles",
      ]);
      expect(await readProviderKeyNames(db)).toEqual(["opensubtitles"]);
    }));

  test("storing a tmdb or tvdb key marks only that provider's unmatched kinds pending", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      const [movieLibrary, showLibrary] = await insertLibraries(db, [
        { name: "Movies", medium: "movies", rootPath: "/m" },
        { name: "Shows", medium: "shows", rootPath: "/s" },
      ]);
      if (!movieLibrary || !showLibrary) {
        throw new Error("Fixture libraries missing.");
      }
      const movie = await insertItem(db, {
        libraryId: movieLibrary.id,
        kind: "movie",
        title: "Unmatched Movie",
        canonicalFolder: "/m/unmatched",
        extension: {},
      });
      const show = await insertItem(db, {
        libraryId: showLibrary.id,
        kind: "show",
        title: "Unmatched Show",
        canonicalFolder: "/s/unmatched",
        extension: {},
      });
      await db
        .update(items)
        .set({ metadataState: "unmatched" })
        .where(eq(items.id, movie.id));
      await db
        .update(items)
        .set({ metadataState: "unmatched" })
        .where(eq(items.id, show.id));

      await setProviderKey(db, admin.id, "opensubtitles", "other-key");
      expect(
        (await db.select().from(items).where(eq(items.id, movie.id)))[0]
          ?.metadataState,
      ).toBe("unmatched");

      await setProviderKey(db, admin.id, "TMDB", "api-key");
      const rows = await db.select().from(items);
      expect(rows.find((row) => row.id === movie.id)?.metadataState).toBe(
        "pending",
      );
      expect(rows.find((row) => row.id === show.id)?.metadataState).toBe(
        "unmatched",
      );

      await db
        .update(items)
        .set({ metadataState: "unmatched" })
        .where(eq(items.id, movie.id));
      await setProviderKey(db, admin.id, "tvdb", "api-key");
      const afterTvdb = await db.select().from(items);
      expect(afterTvdb.find((row) => row.id === show.id)?.metadataState).toBe(
        "pending",
      );
      expect(afterTvdb.find((row) => row.id === movie.id)?.metadataState).toBe(
        "unmatched",
      );
    }));

  test("concurrent sets on a missing row keep both keys", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      await Promise.all([
        setProviderKey(db, admin.id, "tmdb", "secret-one"),
        setProviderKey(db, admin.id, "tvdb", "secret-two"),
      ]);
      expect(await readProviderKeyNames(db)).toEqual(["tmdb", "tvdb"]);
    }));

  test("removing an unknown key is NOT_FOUND", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      await expect(
        removeProviderKey(db, admin.id, "tmdb"),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await setProviderKey(db, admin.id, "tmdb", "secret");
      await expect(
        removeProviderKey(db, admin.id, "tvdb"),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }));

  test("inherited object names are not mistaken for stored keys", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      await expect(
        removeProviderKey(db, admin.id, "constructor"),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(
        await setProviderKey(db, admin.id, "constructor", "secret"),
      ).toEqual(["constructor"]);
      expect(await readProviderKeyNames(db)).toEqual(["constructor"]);
      expect(await removeProviderKey(db, admin.id, "constructor")).toEqual([]);
      expect(await readProviderKeyNames(db)).toEqual([]);
    }));

  test("invalid names and values are INVALID_INPUT", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      for (const name of [
        "",
        "   ",
        "-tmdb",
        "tmdb!",
        "tv db",
        "x".repeat(65),
        "_tmdb",
      ])
        await expect(
          setProviderKey(db, admin.id, name, "secret"),
        ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      for (const value of ["", "   ", "x".repeat(4097), "has\0nul"])
        await expect(
          setProviderKey(db, admin.id, "tmdb", value),
        ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(
        removeProviderKey(db, admin.id, "bad name"),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(await readProviderKeyNames(db)).toEqual([]);
    }));

  test("callers without manage-server are FORBIDDEN", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin, viewer } = await seed(db);
      await setProviderKey(db, admin.id, "tmdb", "secret");
      await expect(
        setProviderKey(db, viewer.id, "tvdb", "secret"),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        removeProviderKey(db, viewer.id, "tmdb"),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }));

  test("no returned value ever contains a stored secret", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      const secret = "super-secret-token-9f8e7d";
      const afterSet = await setProviderKey(db, admin.id, "tmdb", secret);
      const listed = await readProviderKeyNames(db);
      const afterRemove = await removeProviderKey(db, admin.id, "tmdb");
      for (const result of [afterSet, listed, afterRemove])
        expect(JSON.stringify(result)).not.toContain(secret);
    }));
});
