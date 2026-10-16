import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { setupAdmin } from "../auth/accounts.ts";
import { insertItem } from "../db/item-fixtures.ts";
import {
  events,
  files,
  items,
  settings,
  versions,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { remoteMetadataProviders } from "../metadata/lookup.ts";
import { subtitleFolder, writeSubtitle } from "../subtitles/store.ts";
import { setItemLocation } from "./locations.ts";
import {
  homeLibraryId,
  homeLocation,
  inLibraries,
  publishItemChange,
} from "./membership.ts";
import { assetRoots } from "./roots.ts";
import { libraryMetadataGaps, libraryStats, librarySummary } from "./stats.ts";
import { addRoot, insertLibraries } from "./testing.ts";

describe.skipIf(!databaseUrl)("Version membership and home", () => {
  // Proves shared copies have local aggregates but one global identity, with home-specific configuration and asset folders.
  test("shared descendants switch home by import order and retain each root's asset folder", () =>
    withDatabase(async (db) => {
      const folder = await mkdtemp(join(tmpdir(), "thalia-home-"));
      try {
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        const [a, b] = await insertLibraries(db, [
          { name: "A", medium: "shows", rootPath: join(folder, "a") },
          { name: "B", medium: "shows", rootPath: join(folder, "b") },
        ]);
        if (!a || !b) throw new Error("Missing Libraries");
        const aLater = await addRoot(db, a.id, join(folder, "a-later"));
        const show = await insertItem(db, {
          libraryId: a.id,
          kind: "show",
          title: "Shared",
          canonicalFolder: "A show",
          extension: {},
        });
        const season = await insertItem(db, {
          libraryId: a.id,
          kind: "season",
          title: "Season",
          canonicalFolder: "A show",
          parentId: show.id,
          extension: { seasonNumber: 1 },
        });
        const episode = await insertItem(db, {
          libraryId: a.id,
          kind: "episode",
          title: "Episode",
          canonicalFolder: "A show",
          parentId: season.id,
          extension: { episodeNumber: 1 },
        });
        for (const item of [show, season, episode]) {
          await setItemLocation(
            db,
            item.id,
            aLater,
            "A later",
            item.kind === "show" ? "" : null,
          );
          await setItemLocation(
            db,
            item.id,
            b.rootId,
            "Different B folder",
            item.kind === "show" ? "" : null,
          );
        }
        for (const [rootPath, name] of [
          [a.rootPath, "A show"],
          [b.rootPath, "Different B folder"],
        ] as const) {
          await mkdir(join(rootPath, name), { recursive: true });
        }
        const oldA = "00000000-0000-4000-8000-000000000001";
        const oldB = "00000000-0000-4000-8000-000000000002";
        const newA = "00000000-0000-4000-8000-000000000003";
        for (const copy of [
          {
            id: oldB,
            libraryId: b.id,
            rootId: b.rootId,
            bytes: 200n,
            durationSeconds: 200,
            createdAt: new Date("2020-01-01"),
          },
          {
            id: oldA,
            libraryId: a.id,
            rootId: aLater,
            bytes: 100n,
            durationSeconds: 100,
            createdAt: new Date("2020-01-01"),
          },
          {
            id: newA,
            libraryId: a.id,
            rootId: a.rootId,
            bytes: 150n,
            durationSeconds: 150,
            createdAt: new Date("2021-01-01"),
          },
        ]) {
          await db.insert(versions).values({
            ...copy,
            itemId: episode.id,
            itemKind: "episode",
            format: "video",
            label: copy.id,
          });
          await db.insert(files).values({
            versionId: copy.id,
            rootId: copy.rootId,
            libraryId: copy.libraryId,
            itemId: episode.id,
            path: "episode.mkv",
            order: 0,
            bytes: copy.bytes,
            modifiedAt: copy.createdAt,
          });
        }
        for (const item of [show, season, episode]) {
          expect(await homeLocation(db, item.id)).toEqual({
            libraryId: a.id,
            rootId: a.rootId,
            path: a.rootPath,
            canonicalFolder: "A show",
          });
        }
        await db.insert(settings).values({
          key: "metadata",
          value: {
            providerOrder: ["tvdb"],
            libraries: { [a.id]: ["tvdb"], [b.id]: [] },
          },
        });
        await db
          .insert(settings)
          .values({ key: "providers", value: { keys: { tvdb: "test-only" } } });
        expect(
          (await remoteMetadataProviders(db, admin.id, show.id)).map(
            (provider) => provider.id,
          ),
        ).toEqual(["tvdb"]);
        await publishItemChange(db, show.id);
        expect(
          (await db.select().from(events)).map((row) => row.payload),
        ).toEqual(
          expect.arrayContaining([
            { kind: "library.changed", libraryId: a.id },
            { kind: "library.changed", libraryId: b.id },
          ]),
        );
        const stats = await libraryStats(db, admin.id);
        expect(stats.find((row) => row.libraryId === a.id)).toMatchObject({
          items: 1,
          versions: 2,
          bytes: 250,
          runtimeSeconds: 150,
          kinds: { shows: 1, seasons: 1, episodes: 1 },
        });
        expect(stats.find((row) => row.libraryId === b.id)).toMatchObject({
          items: 1,
          versions: 1,
          bytes: 200,
          runtimeSeconds: 200,
          kinds: { shows: 1, seasons: 1, episodes: 1 },
        });
        expect(await librarySummary(db, admin.id)).toMatchObject({
          shows: 1,
          seasons: 1,
          episodes: 1,
          versions: 3,
          bytes: 450,
          runtimeSeconds: 200,
        });
        for (const gaps of await libraryMetadataGaps(db, admin.id))
          expect(gaps).toMatchObject({
            overview: 2,
            providerIds: 2,
            poster: 1,
            still: 1,
          });
        await db.delete(versions).where(eq(versions.id, oldA));
        for (const item of [show, season, episode])
          expect((await homeLocation(db, item.id))?.libraryId).toBe(b.id);
        expect(await remoteMetadataProviders(db, admin.id, show.id)).toEqual(
          [],
        );
        const locations = await assetRoots(db, episode.id);
        expect(locations[0]).toMatchObject({
          id: b.rootId,
          canonicalFolder: "Different B folder",
        });
        expect(
          locations.find((root) => root.id === a.rootId)?.canonicalFolder,
        ).toBe("A show");
        const track = { language: "en", format: "srt" } as const;
        await writeSubtitle(db, episode.id, track, "subtitle");
        expect(
          await Bun.file(
            join(
              b.rootPath,
              "Different B folder",
              ".thalia",
              "subtitles",
              `${episode.id}.en.srt`,
            ),
          ).text(),
        ).toBe("subtitle");
        expect(
          await Bun.file(
            join(
              a.rootPath,
              "A show",
              ".thalia",
              "subtitles",
              `${episode.id}.en.srt`,
            ),
          ).exists(),
        ).toBe(false);
        await db.delete(versions);
        await expect(subtitleFolder(db, episode.id)).rejects.toThrow();
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    }));

  // Proves container membership follows descendant copies without duplicating catalogue rows.
  test("a Show and Season appear once through duplicate Episode copies", () =>
    withDatabase(async (db) => {
      const [library] = await insertLibraries(db, {
        name: "TV",
        medium: "shows",
        rootPath: "/tv",
      });
      if (!library) throw new Error("Missing Library");
      const show = await insertItem(db, {
        libraryId: library.id,
        kind: "show",
        title: "Show",
        canonicalFolder: "Show",
        extension: {},
      });
      const season = await insertItem(db, {
        libraryId: library.id,
        kind: "season",
        title: "Season",
        canonicalFolder: "Show",
        parentId: show.id,
        extension: { seasonNumber: 1 },
      });
      const episode = await insertItem(db, {
        libraryId: library.id,
        kind: "episode",
        title: "Episode",
        canonicalFolder: "Show",
        parentId: season.id,
        extension: { episodeNumber: 1 },
      });
      await db.insert(versions).values(
        ["HD", "UHD"].map((label) => ({
          itemId: episode.id,
          itemKind: "episode" as const,
          libraryId: library.id,
          format: "video" as const,
          bytes: 1n,
          label,
        })),
      );
      const members = await db
        .select({ id: items.id })
        .from(items)
        .where(inLibraries([library.id]));
      expect(new Set(members.map((row) => row.id))).toEqual(
        new Set([show.id, season.id, episode.id]),
      );
      expect(members).toHaveLength(3);
      expect(await db.select().from(items).where(inLibraries([]))).toHaveLength(
        0,
      );
    }));

  // Proves immutable import age, UUID ties and root ordering determine asset configuration.
  test("home uses the oldest imported descendant then the first holding root", () =>
    withDatabase(async (db) => {
      const [library] = await insertLibraries(db, {
        name: "Movies",
        medium: "movies",
        rootPath: "/movies/a",
      });
      if (!library) throw new Error("Missing Library");
      const laterRoot = await addRoot(db, library.id, "/movies/b");
      const item = await insertItem(db, {
        libraryId: library.id,
        kind: "movie",
        title: "Film",
        canonicalFolder: "Film",
        extension: {},
      });
      const earlyId = Bun.randomUUIDv7();
      const laterId = Bun.randomUUIDv7();
      const at = new Date("2020-01-01T00:00:00Z");
      await db.insert(versions).values(
        [earlyId, laterId].map((id) => ({
          id,
          itemId: item.id,
          itemKind: "movie" as const,
          libraryId: library.id,
          format: "video" as const,
          bytes: 1n,
          label: id,
          createdAt: at,
        })),
      );
      for (const [versionId, rootId] of [
        [earlyId, laterRoot],
        [laterId, library.rootId],
      ] as const) {
        await db.insert(files).values({
          versionId,
          rootId,
          itemId: item.id,
          libraryId: library.id,
          path: "Film/movie.mkv",
          order: 0,
          bytes: 1n,
          modifiedAt: at,
        });
      }
      expect(await homeLocation(db, item.id)).toEqual({
        libraryId: library.id,
        rootId: library.rootId,
        path: library.rootPath,
        canonicalFolder: "Film",
      });
      expect(
        await db
          .select({ home: homeLibraryId() })
          .from(items)
          .where(eq(items.id, item.id)),
      ).toEqual([{ home: library.id }]);
      await db.delete(versions).where(eq(versions.id, laterId));
      expect((await homeLocation(db, item.id))?.rootId).toBe(laterRoot);
      await db.delete(versions).where(eq(versions.id, earlyId));
      expect(await homeLocation(db, item.id)).toBeUndefined();
    }));
});
