import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { asc, eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import {
  files,
  itemAncestors,
  items,
  providerIds,
  versions,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createJobQueue } from "../jobs/queue.ts";
import { withVideoFixture } from "../mediums/video-common/fixtures.ts";
import { parseProbeOutput } from "../mediums/video-common/probe.ts";
import { runScanJob } from "./jobs.ts";
import { libraryScanSource, scanShowDirectory } from "./scan.ts";
import { addRoot, insertLibraries } from "./testing.ts";

const probe = async () =>
  parseProbeOutput({
    format: { duration: "60" },
    streams: [
      {
        index: 0,
        codec_type: "video",
        codec_name: "h264",
        width: 1920,
        height: 1080,
      },
    ],
  });

async function put(root: string, path: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), "video");
}

const idsOf = (db: Database, itemId: string) =>
  db
    .select({ provider: providerIds.provider, value: providerIds.value })
    .from(providerIds)
    .where(eq(providerIds.itemId, itemId))
    .orderBy(asc(providerIds.provider));

describe.skipIf(!databaseUrl)("scan provider identity", () => {
  for (const layout of [
    "quality subfolder",
    "quality suffixes",
    "untagged quality subfolder",
  ] as const) {
    // Proves the exact tagged Sinners layouts retain one Movie and two playable copies on repeat scans.
    test(`Sinners ${layout} share one Item with two Versions`, () =>
      withDatabase((db) =>
        withVideoFixture(async (root) => {
          const folder = "hq/Sinners (2025) [tmdbid-1233413]";
          const web = `${folder}/Sinners (2025) [tmdbid-1233413] - [WEBDL-2160p] - AR.mkv`;
          const subfolder =
            layout === "quality subfolder"
              ? "Sinners (2025) [tmdbid-1233413] - [Remux-2160p] [DV HDR10Plus] - [FraMeSToR]/"
              : layout === "untagged quality subfolder"
                ? "Remux-2160p/"
                : "";
          const remuxTitle =
            layout === "untagged quality subfolder"
              ? "Sinners (2025)"
              : "Sinners (2025) [tmdbid-1233413]";
          const remux = `${folder}/${subfolder}${remuxTitle} - [Remux-2160p] [DV HDR10Plus] - [FraMeSToR].mkv`;
          await put(root, web);
          await put(root, remux);
          const [library] = await insertLibraries(db, {
            name: "Movies",
            medium: "movies",
            rootPath: root,
          });
          if (!library) throw new Error("Missing Library");
          const scan = async () => {
            const queue = createJobQueue(db);
            await queue.enqueue({
              type: "scan",
              libraryId: library.id,
              path: ".",
            });
            const source = await libraryScanSource(db, library, probe);
            for (;;) {
              const job = await queue.claim(["scan"]);
              if (!job) break;
              if (job.payload.type !== "scan")
                throw new Error("Expected scan job");
              await runScanJob(db, job.payload, job, source);
              await queue.complete(job);
            }
          };
          await scan();
          const [item] = await db.select().from(items);
          if (!item) throw new Error("Missing Movie");
          expect(await db.select().from(items)).toHaveLength(1);
          expect(await idsOf(db, item.id)).toEqual([
            { provider: "tmdb", value: "1233413" },
          ]);
          const copies = await db.select().from(versions);
          expect(copies).toHaveLength(2);
          expect(copies.every((copy) => copy.itemId === item.id)).toBe(true);
          await scan();
          expect(await db.select().from(items)).toHaveLength(1);
          expect(
            new Set((await db.select().from(versions)).map((copy) => copy.id)),
          ).toEqual(new Set(copies.map((copy) => copy.id)));
          expect(
            (await db.select().from(files)).map((file) => file.path).sort(),
          ).toEqual([web, remux].sort());
        }),
      ));
  }

  // Proves conflicting batches preserve the match, while consistent corrections trigger rematching.
  for (const conflicting of [true, false]) {
    test(`${conflicting ? "conflicting secondary Show assertions preserve the stored IDs and match" : "consistent secondary Show assertions replace the stored ID and rematch"}`, () =>
      withDatabase((db) =>
        withVideoFixture(async (root) => {
          const a = "Breaking Bad S01E01.mkv";
          const b = "Los Pollos Hermanos S01E02.mkv";
          await put(root, a);
          const [library] = await insertLibraries(db, {
            name: "Shows",
            medium: "shows",
            rootPath: root,
          });
          if (!library) throw new Error("Missing Library");
          const initial = await scanShowDirectory(db, library.id, ".", {
            probe,
            changes: [
              {
                kind: "add",
                rootId: library.rootId,
                path: a,
                providerIds: { tvdb: "81189", tmdb: "1396" },
              },
            ],
          });
          if (!initial.itemId) throw new Error("Missing Show");
          await db
            .update(items)
            .set({ metadataState: "matched" })
            .where(eq(items.id, initial.itemId));
          await put(root, b);
          await scanShowDirectory(db, library.id, ".", {
            probe,
            changes: [
              {
                kind: "add",
                rootId: library.rootId,
                path: a,
                providerIds: { tvdb: "81189", tmdb: "100" },
              },
              {
                kind: "add",
                rootId: library.rootId,
                path: b,
                providerIds: {
                  tvdb: "81189",
                  tmdb: conflicting ? "200" : "100",
                },
              },
            ],
          });
          expect(
            await db.select().from(items).where(eq(items.kind, "show")),
          ).toMatchObject([
            {
              id: initial.itemId,
              metadataState: conflicting ? "matched" : "pending",
            },
          ]);
          expect(await idsOf(db, initial.itemId)).toEqual([
            { provider: "tmdb", value: conflicting ? "1396" : "100" },
            { provider: "tvdb", value: "81189" },
          ]);
          expect(await db.select().from(files)).toHaveLength(2);
        }),
      ));
  }

  // Proves deferred folder tags remain usable by later webhook groups, including a repeat scan.
  test("tagged Show roots remain visible to same-scan webhook lookups", () =>
    withDatabase((db) =>
      withVideoFixture(async (dir) => {
        const a = join(dir, "Breaking Bad (2008) [tvdbid-81189]");
        const b = join(dir, "Los Pollos Hermanos");
        const episodeA = "Season 1/Breaking Bad S01E01.mkv";
        const episodeB = "Season 1/Los Pollos Hermanos S01E01.mkv";
        await put(a, episodeA);
        await put(b, episodeB);
        const [library] = await insertLibraries(db, {
          name: "Shows",
          medium: "shows",
          rootPath: a,
        });
        if (!library) throw new Error("Missing Library");
        const rootB = await addRoot(db, library.id, b);
        const options = {
          probe,
          changes: [
            {
              kind: "add" as const,
              rootId: rootB,
              path: episodeB,
              providerIds: { tvdb: "81189" },
            },
          ],
        };
        const first = await scanShowDirectory(db, library.id, ".", options);
        const originalFiles = await db.select().from(files);
        await scanShowDirectory(db, library.id, ".", options);
        expect(
          await db.select().from(items).where(eq(items.kind, "show")),
        ).toMatchObject([{ id: first.itemId }]);
        expect(first.itemIds).toHaveLength(1);
        expect(
          new Set((await db.select().from(files)).map((file) => file.id)),
        ).toEqual(new Set(originalFiles.map((file) => file.id)));
        expect(await idsOf(db, first.itemId ?? "")).toEqual([
          { provider: "tvdb", value: "81189" },
        ]);
        expect(await db.select().from(versions)).toHaveLength(2);
      }),
    ));

  // Proves an earlier correction removes the old lookup ID before another Show claims it.
  for (const tagged of [false, true]) {
    test(`corrected Show IDs cannot capture later groups through superseded IDs (${tagged ? "tagged" : "untagged"} root)`, () =>
      withDatabase((db) =>
        withVideoFixture(async (dir) => {
          const a = join(
            dir,
            `Breaking Bad (2008)${tagged ? " [tvdbid-81189]" : ""}`,
          );
          const b = join(dir, "Los Pollos Hermanos");
          const episodeA = "Season 1/Breaking Bad S01E01.mkv";
          const episodeB = "Season 1/Los Pollos Hermanos S01E01.mkv";
          await put(a, episodeA);
          const [library] = await insertLibraries(db, {
            name: "Shows",
            medium: "shows",
            rootPath: a,
          });
          if (!library) throw new Error("Missing Library");
          const first = await scanShowDirectory(db, library.id, ".", {
            probe,
            changes: [
              {
                kind: "add",
                rootId: library.rootId,
                path: episodeA,
                providerIds: { tvdb: "81189" },
              },
            ],
          });
          if (!first.itemId) throw new Error("Missing Show");
          await put(b, episodeB);
          const rootB = await addRoot(db, library.id, b);
          const options = {
            probe,
            changes: [
              {
                kind: "add" as const,
                rootId: library.rootId,
                path: episodeA,
                providerIds: { tvdb: "99999" },
              },
              {
                kind: "add" as const,
                rootId: rootB,
                path: episodeB,
                providerIds: { tvdb: "81189" },
              },
            ],
          };
          await scanShowDirectory(db, library.id, ".", options);
          const showRows = await db
            .select()
            .from(items)
            .where(eq(items.kind, "show"));
          expect(showRows).toHaveLength(2);
          const other = showRows.find((show) => show.id !== first.itemId);
          if (!other) throw new Error("Missing second Show");
          expect(await idsOf(db, first.itemId)).toEqual([
            { provider: "tvdb", value: "99999" },
          ]);
          expect(await idsOf(db, other.id)).toEqual([
            { provider: "tvdb", value: "81189" },
          ]);
          const ancestry = await db
            .select({ path: files.path, ancestorId: itemAncestors.ancestorId })
            .from(files)
            .innerJoin(
              itemAncestors,
              eq(itemAncestors.descendantId, files.itemId),
            )
            .innerJoin(items, eq(items.id, itemAncestors.ancestorId))
            .where(eq(items.kind, "show"))
            .orderBy(asc(files.path));
          expect(ancestry).toEqual([
            { path: episodeA, ancestorId: first.itemId },
            { path: episodeB, ancestorId: other.id },
          ]);
          await scanShowDirectory(db, library.id, ".", options);
          expect(
            await db.select().from(items).where(eq(items.kind, "show")),
          ).toHaveLength(2);
          expect(await db.select().from(files)).toHaveLength(2);
        }),
      ));
  }
});
