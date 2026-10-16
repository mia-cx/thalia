import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { insertItem } from "../db/item-fixtures.ts";
import { files, items, versions } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { homeLibraryId, homeLocation, inLibraries } from "./membership.ts";
import { addRoot, insertLibraries } from "./testing.ts";

describe.skipIf(!databaseUrl)("Version membership and home", () => {
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
