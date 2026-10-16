import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { createThaliaClient } from "../../../web/src/lib/api.ts";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { login } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import {
  artwork,
  files,
  items,
  providerIds,
  segmentTimelines,
  streams,
  versions,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { insertItem } from "../db/tree.ts";
import { startThalia } from "../index.ts";
import { insertLibraries } from "../libraries/testing.ts";

const device = {
  clientName: "Test Client",
  deviceId: "device-1",
  deviceName: "Living Room",
};

async function seed(db: Database) {
  const admin = await setupAdmin(db, {
    username: "admin",
    password: "admin-pass",
  });
  const { token } = await login(
    db,
    { username: "admin", password: "admin-pass", ...device },
    "127.0.0.1",
  );
  return { admin, token };
}

async function capture(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ORPCError) return error;
    throw error;
  }
  throw new Error("Expected the client call to reject.");
}

type LibraryRow = {
  id: string;
  rootId: string;
  rootPath: string;
};

type Video = {
  codec?: string;
  width?: number;
  height?: number;
  hdr?: string;
  index?: number;
  attachedPicture?: boolean;
  default?: boolean;
};

/** Adds an imported Version to a movie or episode, with one file and the given streams. */
async function addVersion(
  db: Database,
  library: LibraryRow,
  item: { id: string },
  itemKind: "movie" | "episode",
  options: {
    bytes?: bigint;
    durationSeconds?: number;
    video?: Video;
    extraVideo?: Video[];
    noVideo?: boolean;
  } = {},
) {
  const [version] = await db
    .insert(versions)
    .values({
      itemId: item.id,
      itemKind,
      libraryId: library.id,
      label: "Original",
      format: "video",
      bytes: options.bytes ?? 1000n,
      durationSeconds: options.durationSeconds ?? 120,
    })
    .returning();
  if (!version) throw new Error("Version insert returned no row.");
  const [file] = await db
    .insert(files)
    .values({
      versionId: version.id,
      itemId: item.id,
      libraryId: library.id,
      rootId: library.rootId,
      path: `/${version.id}.mkv`,
      order: 0,
      bytes: options.bytes ?? 1000n,
      modifiedAt: new Date(),
    })
    .returning();
  if (!file) throw new Error("File insert returned no row.");
  if (!options.noVideo) {
    const videos = [options.video ?? {}, ...(options.extraVideo ?? [])];
    await db.insert(streams).values(
      videos.map((video, order) => ({
        versionId: version.id,
        fileId: file.id,
        index: video.index ?? order,
        kind: "video" as const,
        codec: video.codec ?? "h264",
        width: video.width ?? 1920,
        height: video.height ?? 1080,
        hdr: video.hdr ?? "sdr",
        disposition: {
          ...(video.attachedPicture ? { attached_pic: true } : {}),
          ...(video.default ? { default: true } : {}),
        },
      })),
    );
  }
  return version;
}

async function addMovie(
  db: Database,
  libraryId: string,
  title: string,
  fields: Partial<
    Omit<typeof items.$inferInsert, "kind" | "parentId" | "extension">
  > = {},
) {
  return insertItem(db, {
    libraryId,
    kind: "movie",
    title,
    canonicalFolder: `/srv/movies/${title.toLowerCase()}`,
    extension: {},
    ...fields,
  });
}

async function addArtwork(
  db: Database,
  itemId: string,
  types: readonly string[],
) {
  await db.insert(artwork).values(
    types.map((type) => ({
      itemId,
      type,
      backend: "colocated" as const,
      storageKey: `${itemId}/${type}.jpg`,
      selected: true,
    })),
  );
}

describe.skipIf(!databaseUrl)("library stats api", () => {
  test("stats aggregates imported Versions per library", () =>
    withDatabase(async (db, url) => {
      const { token } = await seed(db);
      const folder = await mkdtemp(join(tmpdir(), "thalia-stats-"));
      const [movies, shows] = await insertLibraries(db, [
        { name: "Movies", medium: "movies", rootPath: join(folder, "movies") },
        { name: "Shows", medium: "shows", rootPath: join(folder, "shows") },
      ]);
      if (!movies || !shows) throw new Error("Fixture missing.");
      await mkdir(movies.rootPath);
      await mkdir(shows.rootPath);

      // A multi-Version movie: 4K Dolby Vision and 1080p SDR count once for runtime.
      const multi = await addMovie(db, movies.id, "Multi");
      const multiSource = await addVersion(db, movies, multi, "movie", {
        bytes: 4000n,
        durationSeconds: 7000,
        video: {
          codec: "hevc",
          width: 3840,
          height: 2160,
          hdr: "dolby-vision",
          default: true,
        },
      });
      await addVersion(db, movies, multi, "movie", {
        bytes: 2000n,
        durationSeconds: 6000,
      });
      // A stored Version on it never counts; its timeline must match the
      // source Version's, so the imported Version aligns to it too.
      const [timeline] = await db
        .insert(segmentTimelines)
        .values({
          itemId: multi.id,
          cutKey: "original",
          boundariesSeconds: [0, 4, 7000],
        })
        .returning();
      if (!timeline) throw new Error("Timeline insert returned no row.");
      await db
        .update(versions)
        .set({ segmentTimelineId: timeline.id, timelineAligned: true })
        .where(eq(versions.id, multiSource.id));
      const [sourceFile] = await db
        .select({ id: files.id })
        .from(files)
        .where(eq(files.versionId, multiSource.id));
      if (!sourceFile) throw new Error("Source file missing.");
      await db.insert(versions).values({
        itemId: multi.id,
        itemKind: "movie",
        libraryId: movies.id,
        label: "360p",
        format: "video",
        bytes: 1n,
        origin: "stored",
        sourceFileId: sourceFile.id,
        storedFolder: "multi.thalia/360p",
        rung: "360p",
        complete: true,
        segmentTimelineId: timeline.id,
        timelineAligned: true,
      });

      const scope = await addMovie(db, movies.id, "Scope");
      await addVersion(db, movies, scope, "movie", {
        durationSeconds: 100,
        video: { codec: "hevc", width: 3840, height: 1600, hdr: "hdr10" },
      });
      const wide = await addMovie(db, movies.id, "Wide");
      await addVersion(db, movies, wide, "movie", {
        durationSeconds: 200,
        video: { width: 1920, height: 800 },
      });
      const small = await addMovie(db, movies.id, "Small");
      await addVersion(db, movies, small, "movie", {
        durationSeconds: 300,
        video: { width: 1280, height: 720 },
      });
      const low = await addMovie(db, movies.id, "Low");
      await addVersion(db, movies, low, "movie", {
        durationSeconds: 400,
        video: { codec: "mpeg2video", width: 640, height: 480 },
      });
      const silent = await addMovie(db, movies.id, "Silent");
      await addVersion(db, movies, silent, "movie", {
        durationSeconds: 500,
        noVideo: true,
      });
      const cover = await addMovie(db, movies.id, "Cover");
      await addVersion(db, movies, cover, "movie", {
        durationSeconds: 600,
        video: {
          codec: "mjpeg",
          width: 500,
          height: 500,
          index: 0,
          attachedPicture: true,
        },
        extraVideo: [{ codec: "h264", width: 1920, height: 1080, index: 1 }],
      });
      const old = await addMovie(db, movies.id, "Old");
      await addVersion(db, movies, old, "movie", { durationSeconds: 800 });
      await db
        .update(items)
        .set({ addedAt: new Date(Date.now() - 40 * 24 * 3600 * 1000) })
        .where(eq(items.id, old.id));

      // A show library: the Show and Season are containers and never count.
      const show = await insertItem(db, {
        libraryId: shows.id,
        kind: "show",
        title: "Series",
        canonicalFolder: "/srv/shows/series",
        extension: {},
      });
      const season = await insertItem(db, {
        libraryId: shows.id,
        kind: "season",
        parentId: show.id,
        title: "Season 1",
        canonicalFolder: "/srv/shows/series/s1",
        extension: { seasonNumber: 1 },
      });
      for (const [title, episodeNumber] of [
        ["Pilot", 1],
        ["Next", 2],
      ] as const) {
        const episode = await insertItem(db, {
          libraryId: shows.id,
          kind: "episode",
          parentId: season.id,
          title,
          canonicalFolder: `/srv/shows/series/s1/${episodeNumber}`,
          extension: { episodeNumber },
        });
        await addVersion(db, shows, episode, "episode", {
          durationSeconds: 2400,
        });
      }

      const server = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = createThaliaClient({
          origin: base,
          headers: { authorization: `Bearer ${token}` },
        });
        const all = await client.libraries.stats({});
        expect(all.map((entry) => entry.libraryId)).toEqual([
          movies.id,
          shows.id,
        ]);
        const movieStats = all[0];
        expect(movieStats).toMatchObject({
          items: 8,
          versions: 9,
          files: 9,
          bytes: 4000 + 2000 + 7 * 1000,
          runtimeSeconds: 7000 + 100 + 200 + 300 + 400 + 500 + 600 + 800,
          addedLast30Days: 7,
          multiVersionItems: 1,
          resolution: { uhd: 2, fullHd: 4, hd: 1, lower: 1, unknown: 1 },
          dynamicRange: { sdr: 6, hdr: 1, dolbyVision: 1 },
          codecs: [
            { codec: "h264", versions: 5 },
            { codec: "hevc", versions: 2 },
            { codec: "mpeg2video", versions: 1 },
          ],
        });
        expect(all[1]).toMatchObject({ libraryId: shows.id, items: 2 });
        const showsStats = all[1];
        if (showsStats === undefined) throw new Error("Shows stats missing.");
        expect(await client.libraries.stats({ id: shows.id })).toEqual([
          showsStats,
        ]);
        expect(
          await client.libraries.stats({
            id: "00000000-0000-0000-0000-000000000000",
          }),
        ).toEqual([]);
      } finally {
        await server.stop();
      }
    }));

  test("metadata gaps count and list the missing Items", () =>
    withDatabase(async (db, url) => {
      const { token } = await seed(db);
      const folder = await mkdtemp(join(tmpdir(), "thalia-gaps-"));
      const [movies, shows] = await insertLibraries(db, [
        { name: "Movies", medium: "movies", rootPath: join(folder, "movies") },
        { name: "Shows", medium: "shows", rootPath: join(folder, "shows") },
      ]);
      if (!movies || !shows) throw new Error("Fixture missing.");
      await mkdir(movies.rootPath);
      await mkdir(shows.rootPath);

      const complete = await addMovie(db, movies.id, "Complete", {
        overview: "Has it all.",
      });
      await addArtwork(db, complete.id, ["poster", "backdrop"]);
      await db
        .insert(providerIds)
        .values({ itemId: complete.id, provider: "tmdb", value: "1" });

      const cases = [
        {
          title: "NoPoster",
          artwork: ["backdrop"],
          overview: "Set.",
          providerId: true,
        },
        {
          title: "NoBackdrop",
          artwork: ["poster"],
          overview: "Set.",
          providerId: true,
        },
        {
          title: "NoOverview",
          artwork: ["poster", "backdrop"],
          providerId: true,
        },
        {
          title: "NoIds",
          artwork: ["poster", "backdrop"],
          overview: "Set.",
          providerId: false,
        },
      ];
      const gapMovies: Record<string, { id: string }> = {};
      for (const entry of cases) {
        const movie = await addMovie(
          db,
          movies.id,
          entry.title,
          entry.overview === undefined ? {} : { overview: entry.overview },
        );
        await addArtwork(db, movie.id, entry.artwork);
        if (entry.providerId)
          await db.insert(providerIds).values({
            itemId: movie.id,
            provider: "tmdb",
            value: entry.title,
          });
        gapMovies[entry.title] = movie;
      }

      const show = await insertItem(db, {
        libraryId: shows.id,
        kind: "show",
        title: "Series",
        overview: "Set.",
        canonicalFolder: "/srv/shows/series",
        extension: {},
      });
      await addArtwork(db, show.id, ["poster", "backdrop"]);
      await db
        .insert(providerIds)
        .values({ itemId: show.id, provider: "tmdb", value: "s" });
      const season = await insertItem(db, {
        libraryId: shows.id,
        kind: "season",
        parentId: show.id,
        title: "Season 1",
        canonicalFolder: "/srv/shows/series/s1",
        extension: { seasonNumber: 1 },
      });
      const pilot = await insertItem(db, {
        libraryId: shows.id,
        kind: "episode",
        parentId: season.id,
        title: "Pilot",
        overview: "Set.",
        canonicalFolder: "/srv/shows/series/s1/e1",
        extension: { episodeNumber: 1 },
      });
      await db
        .insert(providerIds)
        .values({ itemId: pilot.id, provider: "tmdb", value: "p" });

      const server = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = createThaliaClient({
          origin: base,
          headers: { authorization: `Bearer ${token}` },
        });
        const gaps = await client.libraries.metadataGaps({});
        expect(gaps.map((entry) => entry.libraryId)).toEqual([
          movies.id,
          shows.id,
        ]);
        // The Season misses everything and never counts; only NoOverview misses
        // an overview, and only Pilot misses its still.
        expect(gaps[0]).toEqual({
          libraryId: movies.id,
          poster: 1,
          backdrop: 1,
          overview: 1,
          providerIds: 1,
          still: 0,
        });
        expect(gaps[1]).toEqual({
          libraryId: shows.id,
          poster: 0,
          backdrop: 0,
          overview: 0,
          providerIds: 0,
          still: 1,
        });

        const noPoster = gapMovies.NoPoster;
        if (noPoster === undefined) throw new Error("Fixture missing.");
        const posterItems = await client.libraries.metadataGapItems({
          libraryId: movies.id,
          gap: "poster",
        });
        expect(posterItems.items.map((item) => item.id)).toEqual([noPoster.id]);
        expect(posterItems.items[0]).toMatchObject({
          kind: "movie",
          title: "NoPoster",
          parentId: null,
          show: null,
          seasonNumber: null,
          episodeNumber: null,
        });
        const stillItems = await client.libraries.metadataGapItems({
          libraryId: shows.id,
          gap: "still",
        });
        expect(stillItems.items).toEqual([
          {
            id: pilot.id,
            kind: "episode",
            title: "Pilot",
            year: null,
            parentId: season.id,
            show: { id: show.id, title: "Series" },
            seasonNumber: 1,
            episodeNumber: 1,
          },
        ]);
      } finally {
        await server.stop();
      }
    }));

  test("gap items page by title and reject a foreign cursor", () =>
    withDatabase(async (db, url) => {
      const { token } = await seed(db);
      const folder = await mkdtemp(join(tmpdir(), "thalia-gappage-"));
      const [library] = await insertLibraries(db, {
        name: "Movies",
        medium: "movies",
        rootPath: join(folder, "movies"),
      });
      if (!library) throw new Error("Fixture missing.");
      await mkdir(library.rootPath);
      for (const title of ["Alpha", "Beta", "Gamma"]) {
        const movie = await addMovie(db, library.id, title, {
          overview: "Set.",
        });
        await addArtwork(db, movie.id, ["backdrop"]);
        await db
          .insert(providerIds)
          .values({ itemId: movie.id, provider: "tmdb", value: title });
      }
      const server = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = createThaliaClient({
          origin: base,
          headers: { authorization: `Bearer ${token}` },
        });
        const first = await client.libraries.metadataGapItems({
          libraryId: library.id,
          gap: "poster",
          limit: 2,
        });
        expect(first.items.map((item) => item.title)).toEqual([
          "Alpha",
          "Beta",
        ]);
        expect(first.cursor).not.toBeNull();
        const second = await client.libraries.metadataGapItems({
          libraryId: library.id,
          gap: "poster",
          cursor: first.cursor ?? undefined,
        });
        expect(second.items.map((item) => item.title)).toEqual(["Gamma"]);
        expect(second.cursor).toBeNull();
        const error = await capture(
          client.libraries.metadataGapItems({
            libraryId: library.id,
            gap: "poster",
            cursor: "garbage",
          }),
        );
        expect(error).toBeInstanceOf(ORPCError);
        expect((error as ORPCError<"BAD_REQUEST", unknown>).code).toBe(
          "BAD_REQUEST",
        );
      } finally {
        await server.stop();
      }
    }));

  test("free space groups roots by filesystem and reports unreadable roots", () =>
    withDatabase(async (db, url) => {
      const { token } = await seed(db);
      const folder = await mkdtemp(join(tmpdir(), "thalia-space-"));
      const [movies, shows, broken] = await insertLibraries(db, [
        { name: "Movies", medium: "movies", rootPath: join(folder, "a") },
        { name: "Shows", medium: "shows", rootPath: join(folder, "b") },
        {
          name: "Zulu",
          medium: "movies",
          rootPath: join(folder, "missing", "deep"),
        },
      ]);
      if (!movies || !shows || !broken) throw new Error("Fixture missing.");
      await mkdir(movies.rootPath);
      await mkdir(shows.rootPath);
      const server = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = createThaliaClient({
          origin: base,
          headers: { authorization: `Bearer ${token}` },
        });
        const space = await client.libraries.freeSpace();
        const available = space.filter((entry) => entry.state === "available");
        const unavailable = space.filter(
          (entry) => entry.state === "unavailable",
        );
        expect(available).toHaveLength(1);
        expect(available[0]?.roots.map((root) => root.path)).toEqual([
          join(folder, "a"),
          join(folder, "b"),
        ]);
        if (available[0]?.state !== "available")
          throw new Error("Expected an available filesystem.");
        expect(available[0].totalBytes).toBeGreaterThan(0);
        expect(
          available[0].usedBytes + available[0].availableBytes,
        ).toBeLessThanOrEqual(available[0].totalBytes);
        expect(unavailable).toHaveLength(1);
        expect(unavailable[0]?.roots.map((root) => root.path)).toEqual([
          join(folder, "missing", "deep"),
        ]);
      } finally {
        await server.stop();
      }
    }));

  test("stats, gaps and free space require libraries:manage", () =>
    withDatabase(async (db, url) => {
      const { admin } = await seed(db);
      const viewer = await createLocalUser(db, admin.id, {
        username: "viewer",
        password: "viewer-pass",
      });
      const { token } = await login(
        db,
        { username: "viewer", password: "viewer-pass", ...device },
        "127.0.0.1",
      );
      void viewer;
      const server = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = createThaliaClient({
          origin: base,
          headers: { authorization: `Bearer ${token}` },
        });
        const libraryId = "00000000-0000-0000-0000-000000000000";
        for (const call of [
          () => client.libraries.stats({}),
          () => client.libraries.metadataGaps({}),
          () => client.libraries.metadataGapItems({ libraryId, gap: "poster" }),
          () => client.libraries.freeSpace(),
        ]) {
          const error = await capture(call());
          expect((error as ORPCError<"FORBIDDEN", unknown>).code).toBe(
            "FORBIDDEN",
          );
        }
      } finally {
        await server.stop();
      }
    }));
});
