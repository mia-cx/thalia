import { describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { setupAdmin } from "../auth/accounts.ts";
import { favourites, files, items, versions } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createVideoFixture } from "../mediums/video-common/fixtures.ts";
import { homeLocation, inLibraries } from "./membership.ts";
import { scanDirectory, scanShowDirectory } from "./scan.ts";
import { deleteLibrary, updateLibrary } from "./service.ts";
import { libraryStats, librarySummary } from "./stats.ts";
import { insertLibraries } from "./testing.ts";

describe.skipIf(!databaseUrl)("server-owned shared Items", () => {
  for (const [simultaneous, removal] of [
    [false, "library"],
    [true, "queued"],
    [false, "reconcile"],
    [true, "root"],
  ] as const) {
    // Proves tagged scans in different Libraries share identity even when their writes race.
    test(
      `${simultaneous ? "simultaneous" : "sequential"} tagged imports share one film through ${removal} deletion`,
      () =>
        withDatabase(async (db) => {
          const folder = await mkdtemp(join(tmpdir(), "thalia-shared-"));
          try {
            const admin = await setupAdmin(db, {
              username: "admin",
              password: "admin-pass",
            });
            const movie = "The Matrix (1999) [tmdbid-603]";
            const paths = [join(folder, "a"), join(folder, "b")];
            for (const path of paths)
              await mkdir(join(path, movie), { recursive: true });
            const [firstPath, secondPath] = paths;
            if (!firstPath || !secondPath) throw new Error("Missing paths");
            await createVideoFixture(join(firstPath, movie, "Movie.mkv"));
            await cp(
              join(firstPath, movie, "Movie.mkv"),
              join(secondPath, movie, "Movie.mkv"),
            );
            const [a, b] = await insertLibraries(
              db,
              paths.map((rootPath, index) => ({
                name: String(index),
                medium: "movies" as const,
                rootPath,
              })),
            );
            if (!a || !b) throw new Error("Missing Libraries");
            const importA = () => scanDirectory(db, a.id, movie);
            const importB = () => scanDirectory(db, b.id, movie);
            if (simultaneous) await Promise.all([importA(), importB()]);
            else {
              await importA();
              await importB();
            }
            const [item] = await db.select().from(items);
            if (!item) throw new Error("Missing Item");
            expect(await db.select().from(items)).toHaveLength(1);
            expect(await db.select().from(versions)).toHaveLength(2);
            for (const library of [a, b])
              expect(
                await db
                  .select({ id: items.id })
                  .from(items)
                  .where(inLibraries([library.id])),
              ).toEqual([{ id: item.id }]);
            const local = await libraryStats(db, admin.id);
            for (const library of [a, b])
              expect(
                local.find((row) => row.libraryId === library.id),
              ).toMatchObject({
                items: 1,
                versions: 1,
                files: 1,
                kinds: { movies: 1 },
              });
            expect(await librarySummary(db, admin.id)).toMatchObject({
              movies: 1,
              versions: 2,
              files: 2,
              bytes: local.reduce((sum, row) => sum + row.bytes, 0),
            });
            const original = (
              await db.select({ id: versions.id }).from(versions)
            )
              .map((v) => v.id)
              .sort();
            await Promise.all([importA(), importB()]);
            expect(
              (await db.select({ id: versions.id }).from(versions))
                .map((v) => v.id)
                .sort(),
            ).toEqual(original);
            await db
              .insert(favourites)
              .values({ userId: admin.id, itemId: item.id });
            await deleteLibrary(db, admin.id, a.id);
            expect(await db.select().from(items)).toHaveLength(1);
            expect(await db.select().from(favourites)).toHaveLength(1);
            expect((await homeLocation(db, item.id))?.libraryId).toBe(b.id);
            await updateLibrary(db, admin.id, b.id, {
              roots: [{ path: join(folder, "empty") }],
            });
            expect(await db.select().from(items)).toHaveLength(0);
            expect(await db.select().from(favourites)).toHaveLength(0);
          } finally {
            await rm(folder, { recursive: true, force: true });
          }
        }),
      20_000,
    );
  }

  // Proves a move collision replaces only this root's copy, preserving the other Library and its marks.
  test(
    "a move collision preserves the destination's other Library copy",
    () =>
      withDatabase(async (db) => {
        const folder = await mkdtemp(join(tmpdir(), "thalia-shared-move-"));
        try {
          const admin = await setupAdmin(db, {
            username: "admin",
            password: "admin-pass",
          });
          const [a, b] = await insertLibraries(
            db,
            ["a", "b"].map((name) => ({
              name,
              medium: "movies" as const,
              rootPath: join(folder, name),
            })),
          );
          if (!a || !b) throw new Error("Missing Libraries");
          const destination = "Destination [tmdbid-2]";
          for (const library of [a, b]) {
            await mkdir(join(library.rootPath, destination), {
              recursive: true,
            });
            await createVideoFixture(
              join(library.rootPath, destination, "Movie.mkv"),
            );
            await scanDirectory(db, library.id, destination);
          }
          const [foreign] = await db
            .select()
            .from(files)
            .where(eq(files.libraryId, b.id));
          if (!foreign) throw new Error("Missing foreign File");
          await db
            .insert(favourites)
            .values({ userId: admin.id, itemId: foreign.itemId });
          await mkdir(join(a.rootPath, "Source"));
          await createVideoFixture(join(a.rootPath, "Source", "Movie.mkv"));
          await scanDirectory(db, a.id, "Source");
          await rename(
            join(a.rootPath, "Source", "Movie.mkv"),
            join(a.rootPath, destination, "Movie.mkv"),
          );
          await scanDirectory(db, a.id, destination, {
            changes: [
              {
                kind: "move",
                rootId: a.rootId,
                previousPath: "Source/Movie.mkv",
                path: `${destination}/Movie.mkv`,
                providerIds: {},
              },
            ],
          });
          expect(
            await db.select().from(files).where(eq(files.id, foreign.id)),
          ).toEqual([foreign]);
          expect(await db.select().from(favourites)).toHaveLength(1);
          expect(await db.select().from(items)).toHaveLength(1);
          expect(await db.select().from(versions)).toHaveLength(2);
        } finally {
          await rm(folder, { recursive: true, force: true });
        }
      }),
    20_000,
  );

  // Proves a shared Show survives a removed Library and is pruned after its final descendant copy.
  test(
    "Shows share their tree while Episodes retain their copy Libraries",
    () =>
      withDatabase(async (db) => {
        const folder = await mkdtemp(join(tmpdir(), "thalia-shared-show-"));
        try {
          const admin = await setupAdmin(db, {
            username: "admin",
            password: "admin-pass",
          });
          const show = "Severance (2022) [tvdbid-371980]";
          const [a, b] = await insertLibraries(
            db,
            ["a", "b"].map((name) => ({
              name,
              medium: "shows" as const,
              rootPath: join(folder, name),
            })),
          );
          if (!a || !b) throw new Error("Missing Libraries");
          for (const [index, library] of [a, b].entries()) {
            await mkdir(join(library.rootPath, show), { recursive: true });
            await createVideoFixture(
              join(library.rootPath, show, `Severance.S01E0${index + 1}.mkv`),
            );
            await scanShowDirectory(db, library.id, show);
          }
          expect(
            await db.select().from(items).where(eq(items.kind, "show")),
          ).toHaveLength(1);
          expect(
            await db.select().from(items).where(eq(items.kind, "season")),
          ).toHaveLength(1);
          expect(
            await db.select().from(items).where(eq(items.kind, "episode")),
          ).toHaveLength(2);
          await deleteLibrary(db, admin.id, a.id);
          expect(
            await db.select().from(items).where(eq(items.kind, "episode")),
          ).toHaveLength(1);
          expect(await db.select().from(files)).toHaveLength(1);
          await deleteLibrary(db, admin.id, b.id);
          expect(await db.select().from(items)).toHaveLength(0);
        } finally {
          await rm(folder, { recursive: true, force: true });
        }
      }),
    20_000,
  );
});
