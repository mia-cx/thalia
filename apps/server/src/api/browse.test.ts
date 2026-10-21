import { describe, expect, test } from "bun:test";
import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { eq, sql } from "drizzle-orm";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { setPermissionOverride } from "../auth/permissions.ts";
import { authenticate, createApiKey } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { insertItem, insertItems } from "../db/item-fixtures.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  accessRules,
  artwork,
  contributors,
  credits,
  episodes,
  files,
  items,
  progress,
  streams,
  versions,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startThalia } from "../index.ts";
import { insertLibraries } from "../libraries/testing.ts";
import { homeShelves } from "./browse.ts";
import { fromHost, runApi } from "./errors.ts";
import { getItemDetail, type ListItemsInput, listItemCards } from "./items.ts";
import type { thaliaRouter } from "./router.ts";

function rpcClient(base: string, token: string) {
  const link = new RPCLink({
    url: `${base}/rpc`,
    headers: { authorization: `Bearer ${token}` },
  });
  return createORPCClient<RouterClient<typeof thaliaRouter>>(link);
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

async function seedViewer(db: Database) {
  const admin = await setupAdmin(db, {
    username: "admin",
    password: "admin-pass",
  });
  const viewer = await createLocalUser(db, admin.id, {
    username: "viewer",
    password: "viewer-pass",
  });
  const { token } = await createApiKey(db, viewer.id, "browse");
  return { admin, viewer, token };
}

async function addLibrary(
  db: Database,
  name: string,
  medium: "movies" | "shows" = "movies",
) {
  const [library] = await insertLibraries(db, {
    name,
    medium,
    rootPath: `/srv/${name}`,
  });
  if (!library) throw new Error("Library insert returned no row.");
  return library;
}

const sizeOfGeneratedLibrary = 10_000;
const timedRuns = 5;
const gridBudgetMs = 50;

// Bulk rows straight into the tables: the grid reads items and their selected
// poster, so the dataset carries both.
async function generateMovies(db: Database, libraryId: string, count: number) {
  await db.execute(sql`
    with inserted as (
      insert into items (id, kind, title, year, added_at)
      select uuidv7(), 'movie', initcap(md5(n::text)), 1950 + n % 75,
        timestamptz '2026-01-01' + n * interval '1 minute'
      from generate_series(1, ${count}) as n returning id
    ), closure as (
      insert into item_ancestors (id, ancestor_id, descendant_id, depth)
      select uuidv7(), id, id, 0 from inserted
    )
    insert into versions (id, item_id, item_kind, library_id, label, format, bytes)
    select uuidv7(), id, 'movie', ${libraryId}::uuid, 'Original', 'video', 1 from inserted
  `);
  await db.execute(sql`
    insert into artwork (id, item_id, type, backend, storage_key, selected)
    select uuidv7(), id, 'poster', 'colocated', id::text || '/poster.jpg', true
    from items
  `);
  await db.execute(sql`analyze items`);
  await db.execute(sql`analyze artwork`);
  // Membership and home queries need statistics for the bulk-inserted copies too.
  await db.execute(sql`analyze versions`);
  await db.execute(sql`analyze item_ancestors`);
}

async function medianMs(run: () => Promise<unknown>) {
  await run();
  const samples: number[] = [];
  for (let index = 0; index < timedRuns; index += 1) {
    const started = performance.now();
    await run();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] ?? Number.POSITIVE_INFINITY;
}

describe.skipIf(!databaseUrl)("browse grids", () => {
  test("the title sort pages A to Z without gaps or repeats", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { token } = await seedViewer(db);
      const library = await addLibrary(db, "Movies");
      const titles = ["Brazil", "alien", "Alien", "Zodiac", "Heat", "Up"];
      await insertItems(
        db,
        titles.map((title, index) => ({
          libraryId: library.id,
          kind: "movie" as const,
          withVersion: true,
          title,
          canonicalFolder: `movie-${index}`,
        })),
      );
      const expected = (
        await db.execute<{ title: string }>(
          sql`select title from items order by title, id`,
        )
      ).map((row) => row.title);
      const server = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const client = rpcClient(
          `http://127.0.0.1:${server.apiServer?.port}`,
          token,
        );
        const seen: string[] = [];
        let cursor: string | null = null;
        for (;;) {
          const page = await client.items.list({
            kind: "movie",
            sort: "title",
            limit: 4,
            ...(cursor === null ? {} : { cursor }),
          });
          seen.push(...page.items.map((item) => item.title));
          if (page.cursor === null) break;
          cursor = page.cursor;
        }
        expect(seen).toEqual(expected);

        const added = await client.items.list({ limit: 2 });
        const titled = await client.items.list({ sort: "title", limit: 2 });
        if (added.cursor === null || titled.cursor === null)
          throw new Error("Expected a second page.");
        const crossed = [
          capture(client.items.list({ sort: "title", cursor: added.cursor })),
          capture(client.items.list({ sort: "added", cursor: titled.cursor })),
        ];
        for (const error of await Promise.all(crossed))
          expect(error.code).toBe("BAD_REQUEST");
      } finally {
        await server.stop();
      }
    }));

  test(
    `grids answer under ${gridBudgetMs} ms at ${sizeOfGeneratedLibrary} items, with or without Item rules`,
    () =>
      withDatabase(async (db) => {
        await migrateDatabase(db);
        const { viewer, token } = await seedViewer(db);
        const library = await addLibrary(db, "Movies");
        await generateMovies(db, library.id, sizeOfGeneratedLibrary);
        const caller = await authenticate(db, token);
        const list = (input: ListItemsInput) =>
          runApi(listItemCards(db, caller, input));
        const answerInBudget = async () => {
          for (const sort of ["added", "title"] as const) {
            const first = await list({ kind: "movie", sort });
            expect(first.items).toHaveLength(24);
            if (first.cursor === null) throw new Error("Expected a cursor.");
            const cursor = first.cursor;
            const firstPageMs = await medianMs(() =>
              list({ kind: "movie", sort }),
            );
            const nextPageMs = await medianMs(() =>
              list({ kind: "movie", sort, cursor }),
            );
            expect(firstPageMs).toBeLessThan(gridBudgetMs);
            expect(nextPageMs).toBeLessThan(gridBudgetMs);
          }
        };
        await answerInBudget();
        // A dozen allows and denies take the restricted filter's slowest path.
        const ruled = await db.select({ id: items.id }).from(items).limit(12);
        await db.insert(accessRules).values(
          ruled.map(({ id }, index) => ({
            action: "view" as const,
            itemId: id,
            userId: viewer.id,
            allowed: index % 2 === 0,
          })),
        );
        await answerInBudget();
      }),
    60_000,
  );
});

// A Show with Seasons and Episodes inserted out of order, so reads must sort.
async function seedShow(db: Database, libraryId: string, content = true) {
  const show = await insertItem(db, {
    libraryId,
    kind: "show",
    title: "Severance",
    canonicalFolder: "Severance",
    extension: {},
  });
  const seasonTwo = await insertItem(db, {
    libraryId,
    kind: "season",
    parentId: show.id,
    title: "Season 2",
    canonicalFolder: "Severance",
    extension: { seasonNumber: 2 },
  });
  const seasonOne = await insertItem(db, {
    libraryId,
    kind: "season",
    parentId: show.id,
    title: "Season 1",
    canonicalFolder: "Severance",
    extension: { seasonNumber: 1 },
  });
  const episodes = [];
  for (const episodeNumber of [3, 1, 2]) {
    episodes[episodeNumber] = await insertItem(db, {
      withVersion: content || episodeNumber !== 1,
      libraryId,
      kind: "episode",
      parentId: seasonOne.id,
      title: `Episode ${episodeNumber}`,
      canonicalFolder: "Severance",
      extension: { episodeNumber },
    });
  }
  const [poster, backdrop, logo] = await db
    .insert(artwork)
    .values(
      ["poster", "backdrop", "logo"].map((type) => ({
        itemId: show.id,
        type,
        backend: "colocated" as const,
        storageKey: `Severance/${type}.jpg`,
        selected: true,
      })),
    )
    .returning();
  const first = episodes[1];
  if (!first || !poster || !backdrop || !logo)
    throw new Error("Seeding returned no row.");
  const [thumb] = await db
    .insert(artwork)
    .values({
      itemId: first.id,
      type: "thumb",
      backend: "colocated",
      storageKey: "Severance/thumb.jpg",
      selected: true,
    })
    .returning();
  if (!thumb) throw new Error("Seeding returned no row.");
  return { show, seasonOne, seasonTwo, first, poster, backdrop, logo, thumb };
}

describe.skipIf(!databaseUrl)("browse details", () => {
  test("a detail lists children, credits and Versions in order", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { token } = await seedViewer(db);
      const library = await addLibrary(db, "Shows", "shows");
      const seeded = await seedShow(db, library.id, false);
      const people = await db
        .insert(contributors)
        .values([
          { name: "Ben Stiller" },
          { name: "Adam Scott" },
          { name: "Britt Lower" },
          { name: "Dan Erickson" },
        ])
        .returning();
      const [director, adam, britt, writer] = people;
      if (!director || !adam || !britt || !writer)
        throw new Error("Contributor insert returned no row.");
      await db.insert(credits).values([
        {
          itemId: seeded.first.id,
          contributorId: director.id,
          role: "director",
          order: 0,
        },
        {
          itemId: seeded.first.id,
          contributorId: writer.id,
          role: "writer",
          order: 0,
        },
        {
          itemId: seeded.first.id,
          contributorId: britt.id,
          role: "actor",
          character: "Helly R.",
          order: 1,
        },
        {
          itemId: seeded.first.id,
          contributorId: adam.id,
          role: "actor",
          character: "Mark S.",
          order: 0,
        },
      ]);
      const insertedVersions = await db
        .insert(versions)
        .values(
          ["Director's Cut", "Broadcast"].map((label) => ({
            itemId: seeded.first.id,
            itemKind: "episode" as const,
            libraryId: library.id,
            label,
            format: "video" as const,
            bytes: 5_000_000_000n,
            durationSeconds: 3300,
          })),
        )
        .returning();
      const broadcast = insertedVersions.find(
        (version) => version.label === "Broadcast",
      );
      if (!broadcast) throw new Error("Version insert returned no row.");
      const [file] = await db
        .insert(files)
        .values({
          versionId: broadcast.id,
          itemId: seeded.first.id,
          libraryId: library.id,
          rootId: library.rootId,
          path: "episode.mkv",
          order: 0,
          bytes: 5_000_000_000n,
          modifiedAt: new Date(),
          container: "mkv",
          durationSeconds: 3300,
        })
        .returning();
      if (!file) throw new Error("File insert returned no row.");
      await db.insert(streams).values([
        {
          versionId: broadcast.id,
          fileId: file.id,
          index: 0,
          kind: "video",
          codec: "h264",
          profile: "high",
          width: 1920,
          height: 1080,
          hdr: "sdr",
          disposition: { default: true },
        },
        {
          versionId: broadcast.id,
          fileId: file.id,
          index: 1,
          kind: "audio",
          codec: "aac",
          language: "eng",
          channels: 2,
        },
        {
          versionId: broadcast.id,
          fileId: file.id,
          index: 2,
          kind: "subtitle",
          codec: "subrip",
          title: "Forced",
          disposition: { forced: true },
        },
      ]);
      const caller = await authenticate(db, token);

      const show = await runApi(getItemDetail(db, caller, seeded.show.id));
      expect(show.children.map((child) => child.seasonNumber)).toEqual([1]);
      expect(show.posterArtworkId).toBe(seeded.poster.id);
      expect(show.show).toBeNull();

      const season = await runApi(
        getItemDetail(db, caller, seeded.seasonOne.id),
      );
      expect(season.show?.id).toBe(seeded.show.id);
      expect(season.children.map((child) => child.episodeNumber)).toEqual([
        1, 2, 3,
      ]);
      expect(season.children[0]).toMatchObject({
        parentId: seeded.seasonOne.id,
        seasonNumber: 1,
        thumbArtworkId: seeded.thumb.id,
        show: {
          id: seeded.show.id,
          title: "Severance",
          posterArtworkId: seeded.poster.id,
          backdropArtworkId: seeded.backdrop.id,
          logoArtworkId: seeded.logo.id,
        },
      });

      const episode = await runApi(getItemDetail(db, caller, seeded.first.id));
      expect(episode).toMatchObject({
        parentId: seeded.seasonOne.id,
        seasonNumber: 1,
        episodeNumber: 1,
        episodeEndNumber: null,
        thumbArtworkId: seeded.thumb.id,
        show: {
          id: seeded.show.id,
          backdropArtworkId: seeded.backdrop.id,
          logoArtworkId: seeded.logo.id,
        },
        children: [],
      });
      expect(episode.credits).toEqual([
        {
          contributorId: adam.id,
          name: "Adam Scott",
          role: "actor",
          character: "Mark S.",
        },
        {
          contributorId: britt.id,
          name: "Britt Lower",
          role: "actor",
          character: "Helly R.",
        },
        {
          contributorId: director.id,
          name: "Ben Stiller",
          role: "director",
          character: null,
        },
        {
          contributorId: writer.id,
          name: "Dan Erickson",
          role: "writer",
          character: null,
        },
      ]);
      expect(episode.versions.map((version) => version.label)).toEqual([
        "Broadcast",
        "Director's Cut",
      ]);
      expect(episode.versions[0]).toMatchObject({
        format: "video",
        durationSeconds: 3300,
        bytes: 5_000_000_000,
        container: "mkv",
      });
      expect(episode.versions[0]?.streams).toEqual([
        {
          index: 0,
          kind: "video",
          codec: "h264",
          profile: "high",
          language: null,
          title: null,
          channels: null,
          width: 1920,
          height: 1080,
          hdr: "sdr",
          default: true,
          forced: false,
        },
        {
          index: 1,
          kind: "audio",
          codec: "aac",
          profile: null,
          language: "eng",
          title: null,
          channels: 2,
          width: null,
          height: null,
          hdr: null,
          default: false,
          forced: false,
        },
        {
          index: 2,
          kind: "subtitle",
          codec: "subrip",
          profile: null,
          language: null,
          title: "Forced",
          channels: null,
          width: null,
          height: null,
          hdr: null,
          default: false,
          forced: true,
        },
      ]);
      // The other Version has no File: no container, no Streams.
      expect(episode.versions[1]).toMatchObject({
        container: null,
        streams: [],
      });
      expect(episode.canDownload).toBe(true);
    }));

  test("canDownload is false when download is denied on the library", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin, viewer, token } = await seedViewer(db);
      const library = await addLibrary(db, "Shows", "shows");
      const seeded = await seedShow(db, library.id);
      const caller = await authenticate(db, token);
      expect(
        (await runApi(getItemDetail(db, caller, seeded.first.id))).canDownload,
      ).toBe(true);
      await setPermissionOverride(db, admin.id, viewer.id, "download", false);
      expect(
        (await runApi(getItemDetail(db, caller, seeded.first.id))).canDownload,
      ).toBe(false);
    }));

  test("an Item download deny overrides its Library allow", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { viewer, token } = await seedViewer(db);
      const library = await addLibrary(db, "Shows", "shows");
      const seeded = await seedShow(db, library.id);
      await db.insert(accessRules).values([
        {
          userId: viewer.id,
          libraryId: library.id,
          action: "download",
          allowed: true,
        },
        {
          userId: viewer.id,
          itemId: seeded.first.id,
          action: "download",
          allowed: false,
        },
      ]);
      const caller = await authenticate(db, token);
      expect(
        (await runApi(getItemDetail(db, caller, seeded.first.id))).canDownload,
      ).toBe(false);
    }));

  test("a season's children carry overview, runtime and the caller's progress", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { viewer, token } = await seedViewer(db);
      const library = await addLibrary(db, "Shows", "shows");
      const seeded = await seedShow(db, library.id);
      const episodeRows = await db
        .select({ id: episodes.itemId, number: episodes.episodeNumber })
        .from(episodes)
        .orderBy(episodes.episodeNumber);
      const second = episodeRows[1];
      const third = episodeRows[2];
      if (episodeRows.length !== 3 || !second || !third)
        throw new Error("Expected three episodes.");
      await db
        .update(items)
        .set({ overview: "The first episode." })
        .where(eq(items.id, seeded.first.id));
      await db.insert(versions).values([
        // The later label sorts second; only the first wins the runtime.
        {
          itemId: seeded.first.id,
          itemKind: "episode" as const,
          libraryId: library.id,
          label: "B Extended",
          format: "video" as const,
          bytes: 9_000_000_000n,
          durationSeconds: 4000,
        },
        {
          itemId: seeded.first.id,
          itemKind: "episode" as const,
          libraryId: library.id,
          label: "A Broadcast",
          format: "video" as const,
          bytes: 5_000_000_000n,
          durationSeconds: 2700,
        },
        {
          itemId: second.id,
          itemKind: "episode" as const,
          libraryId: library.id,
          label: "Broadcast",
          format: "video" as const,
          bytes: 5_000_000_000n,
          durationSeconds: 2400,
        },
      ]);
      await db.insert(progress).values({
        userId: viewer.id,
        itemId: seeded.first.id,
        format: "video" as const,
        positionSeconds: 900,
        updatedAt: new Date("2026-01-02T03:04:05.678Z"),
      });
      const caller = await authenticate(db, token);

      const season = await runApi(
        getItemDetail(db, caller, seeded.seasonOne.id),
      );
      const [first, secondChild, thirdChild] = season.children;
      expect(first).toMatchObject({
        overview: "The first episode.",
        durationSeconds: 2700,
        progress: {
          positionSeconds: 900,
          completed: false,
          updatedAt: "2026-01-02T03:04:05.678000Z",
        },
      });
      expect(secondChild).toMatchObject({
        overview: null,
        durationSeconds: 2400,
        progress: null,
      });
      expect(thirdChild).toMatchObject({
        overview: null,
        durationSeconds: null,
        progress: null,
      });
    }));

  test("a user denied the library cannot read its details", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { viewer, token } = await seedViewer(db);
      const library = await addLibrary(db, "Shows", "shows");
      const seeded = await seedShow(db, library.id);
      await db.insert(accessRules).values({
        action: "view",
        libraryId: library.id,
        userId: viewer.id,
        allowed: false,
      });
      const caller = await authenticate(db, token);
      const error = await capture(
        runApi(getItemDetail(db, caller, seeded.first.id)),
      );
      expect(error.code).toBe("FORBIDDEN");
    }));
});

describe.skipIf(!databaseUrl)("browse home", () => {
  test("home assembles its shelves from a seeded library", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { viewer, token } = await seedViewer(db);
      const movies = await addLibrary(db, "Movies");
      const shows = await addLibrary(db, "Shows", "shows");
      const seeded = await seedShow(db, shows.id);
      const [arrival, heat] = await insertItems(
        db,
        ["Arrival", "Heat"].map((title, index) => ({
          libraryId: movies.id,
          kind: "movie" as const,
          withVersion: true,
          title,
          canonicalFolder: title,
          addedAt: new Date(Date.UTC(2030, 0, index + 1)),
        })),
      );
      if (!arrival || !heat) throw new Error("Item insert returned no row.");
      const [version] = await db
        .insert(versions)
        .values({
          itemId: arrival.id,
          itemKind: "movie",
          libraryId: movies.id,
          label: "Original",
          format: "video",
          bytes: 1n,
          durationSeconds: 7000,
        })
        .returning();
      if (!version) throw new Error("Version insert returned no row.");
      const [arrivalBackdrop, arrivalLogo] = await db
        .insert(artwork)
        .values(
          ["backdrop", "logo"].map((type) => ({
            itemId: arrival.id,
            type,
            backend: "colocated" as const,
            storageKey: `Arrival/${type}.jpg`,
            selected: true,
          })),
        )
        .returning();
      if (!arrivalBackdrop || !arrivalLogo)
        throw new Error("Artwork insert returned no row.");
      await db.insert(progress).values([
        {
          userId: viewer.id,
          itemId: arrival.id,
          versionId: version.id,
          format: "video",
          positionSeconds: 600,
          playedAt: new Date(),
        },
        {
          userId: viewer.id,
          itemId: seeded.first.id,
          format: "video",
          completed: true,
          playedAt: new Date(),
        },
      ]);
      const caller = await authenticate(db, token);
      const home = () =>
        runApi(fromHost(() => homeShelves(db, caller.user.id)));

      const shelves = await home();
      expect(shelves.map((shelf) => shelf.id)).toEqual([
        "continue-watching",
        "next-up",
        "recently-added",
      ]);
      const [resume, next, added] = shelves;
      expect(resume?.title).toBe("Continue watching");
      expect(resume?.entries).toEqual([
        {
          item: expect.objectContaining({
            id: arrival.id,
            title: "Arrival",
            backdropArtworkId: arrivalBackdrop.id,
            logoArtworkId: arrivalLogo.id,
          }),
          progress: { positionSeconds: 600, durationSeconds: 7000 },
        },
      ]);
      expect(next?.title).toBe("Next up");
      expect(next?.entries.map((entry) => entry.item)).toEqual([
        expect.objectContaining({
          title: "Episode 2",
          seasonNumber: 1,
          episodeNumber: 2,
          show: expect.objectContaining({ id: seeded.show.id }),
        }),
      ]);
      expect(added?.entries.map((entry) => entry.item.title)).toEqual([
        "Heat",
        "Arrival",
        "Severance",
      ]);

      await db.insert(accessRules).values({
        action: "view",
        libraryId: shows.id,
        userId: viewer.id,
        allowed: false,
      });
      const denied = await home();
      expect(denied.map((shelf) => shelf.id)).toEqual([
        "continue-watching",
        "recently-added",
      ]);
      expect(denied.at(-1)?.entries.map((entry) => entry.item.title)).toEqual([
        "Heat",
        "Arrival",
      ]);
    }));
});

describe.skipIf(!databaseUrl)("browse search", () => {
  test("search forgives misspellings and stays inside viewable libraries", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { viewer, token } = await seedViewer(db);
      const open = await addLibrary(db, "Movies");
      const hidden = await addLibrary(db, "Hidden");
      const titles = ["Interstellar", "Inception", "Heat", "The Prestige"];
      await insertItems(db, [
        ...titles.map((title) => ({
          libraryId: open.id,
          kind: "movie" as const,
          withVersion: true,
          title,
          canonicalFolder: title,
        })),
        {
          libraryId: hidden.id,
          kind: "movie" as const,
          withVersion: true,
          title: "Interstellar Wars",
          canonicalFolder: "Interstellar Wars",
        },
      ]);
      await db.insert(accessRules).values({
        action: "view",
        libraryId: hidden.id,
        userId: viewer.id,
        allowed: false,
      });
      const server = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const client = rpcClient(
          `http://127.0.0.1:${server.apiServer?.port}`,
          token,
        );
        const titlesFor = async (query: string) =>
          (await client.items.search({ query })).map((item) => item.title);
        expect(await titlesFor("Interstelar")).toEqual(["Interstellar"]);
        expect((await titlesFor("  incep "))[0]).toBe("Inception");
        expect(await titlesFor("prestige")).toEqual(["The Prestige"]);
        expect(await titlesFor("Zxqvw")).toEqual([]);
        for (const query of ["   ", "a\0b", "x".repeat(201)])
          expect((await capture(client.items.search({ query }))).code).toBe(
            "BAD_REQUEST",
          );
      } finally {
        await server.stop();
      }
    }));

  test("search finds Seasons and Episodes with their Show when kinds say so", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { token } = await seedViewer(db);
      const library = await addLibrary(db, "Shows", "shows");
      const seeded = await seedShow(db, library.id);
      const server = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const client = rpcClient(
          `http://127.0.0.1:${server.apiServer?.port}`,
          token,
        );
        const results = await client.items.search({
          query: "Episode",
          kinds: ["season", "episode"],
        });
        expect(results).toContainEqual(
          expect.objectContaining({
            kind: "episode",
            title: "Episode 1",
            show: expect.objectContaining({
              id: seeded.show.id,
              title: "Severance",
            }),
          }),
        );
        // The default kinds keep the Search page to Movies and Shows.
        const fallback = await client.items.search({ query: "Episode" });
        expect(fallback.map((item) => item.kind)).toEqual([]);
      } finally {
        await server.stop();
      }
    }));
});
