import { and, eq, isNull } from "drizzle-orm";
import { publishEvent } from "../api/events.ts";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import { itemFolders as locations } from "../db/schema/core.ts";
import {
  itemAncestors,
  items,
  type JobPayload,
  jobs,
  libraries,
  libraryRoots,
  scanFailures,
} from "../db/schema/index.ts";
import { createJobQueue, type Job } from "../jobs/queue.ts";
import type { createJobRegistry } from "../jobs/registry.ts";
import { queueProviderFetch } from "../metadata/jobs.ts";
import { reconcileStoredVersions } from "../stored/reconcile.ts";
import { runKeyframeIndexJob } from "./keyframe-index.ts";
import {
  libraryScanSource,
  type ScanSource,
  scanDirectory,
  scanScope,
  scanShowDirectory,
} from "./scan.ts";
import { enqueueScan, isLibraryScan } from "./scan-payload.ts";
import {
  countFolderScan,
  failScanJob,
  fanOutScanRun,
  startScanRun,
} from "./scan-runs.ts";

/** The concurrency key that serializes every job for one library. */
export function libraryConcurrencyKey(libraryId: string) {
  return `library:${libraryId}`;
}

/** Registers the built-in library scan and keyframe-index job handlers. */
export function registerLibraryJobs(
  db: Database,
  registry: ReturnType<typeof createJobRegistry>,
) {
  registry.register("scan", async (payload, job) => {
    try {
      await runScanJob(db, payload, job);
    } catch (error) {
      if (job.attempts >= job.maxAttempts)
        await failScanJob(
          db,
          job.id,
          error instanceof Error ? error.message : String(error),
        );
      throw error;
    }
  });
  registry.register("keyframe-index", (payload) =>
    runKeyframeIndexJob(db, payload),
  );
}

/** Runs one scan job, reading files from the local disk unless a source is given. */
export async function runScanJob(
  db: Database,
  payload: Extract<JobPayload, { type: "scan" }>,
  job: Pick<Job, "id">,
  source?: ScanSource,
) {
  const [library] = await db
    .select()
    .from(libraries)
    .where(eq(libraries.id, payload.libraryId));
  if (!library) throw new AuthError("NOT_FOUND");
  const files = source ?? (await libraryScanSource(db, library));
  if (!isLibraryScan(payload)) {
    const count = await countFolderScan(db, library, job.id, payload.path);
    const options = {
      source: files,
      changes: payload.changes,
      reconcileMissing: payload.reconcileMissing,
    };
    // Every Item the directory scan wrote may need its own metadata fetch.
    const itemIds =
      library.medium === "movies"
        ? (await scanDirectory(db, library.id, payload.path, options)).itemIds
        : (await scanShowDirectory(db, library.id, payload.path, options))
            .itemIds;
    for (const itemId of itemIds) {
      // One fetch covers the whole Show, so a new pending Episode under a
      // matched Show queues it too.
      const [pending] = await db
        .select({ id: items.id })
        .from(items)
        .innerJoin(locations, eq(locations.itemId, items.id))
        .innerJoin(libraryRoots, eq(libraryRoots.id, locations.rootId))
        .innerJoin(itemAncestors, eq(itemAncestors.descendantId, items.id))
        .where(
          and(
            eq(itemAncestors.ancestorId, itemId),
            eq(items.metadataState, "pending"),
          ),
        )
        .limit(1);
      if (pending !== undefined) await queueProviderFetch(db, itemId);
    }
    await reconcileStoredVersions(db, library, payload.path);
    await count?.finish();
    await publishEvent(db, {
      kind: "library.changed",
      libraryId: library.id,
    });
    return;
  }
  await startScanRun(db, library.id, job.id);
  const walked = await files.walk(".", true);
  const { rules } = scanScope(library.medium);
  // Each folder to scan, with the media files the walk found in it.
  const paths = new Map<string, number>();
  for (const file of walked) {
    const folder = rules.identify(file.path)?.canonicalFolder;
    if (folder !== undefined) paths.set(folder, (paths.get(folder) ?? 0) + 1);
  }
  const existing = await db
    .select({ canonicalFolder: locations.canonicalFolder })
    .from(items)
    .innerJoin(locations, eq(locations.itemId, items.id))
    .innerJoin(libraryRoots, eq(libraryRoots.id, locations.rootId))
    .where(
      and(
        eq(libraryRoots.libraryId, library.id),
        eq(items.kind, library.medium === "movies" ? "movie" : "show"),
        isNull(items.parentId),
      ),
    );
  for (const item of existing)
    paths.set(item.canonicalFolder, paths.get(item.canonicalFolder) ?? 0);
  // A failed-only folder has no Item to keep it in the fan-out after removal.
  const failed = await db
    .select({ path: scanFailures.path })
    .from(scanFailures)
    .innerJoin(libraryRoots, eq(libraryRoots.id, scanFailures.rootId))
    .where(eq(libraryRoots.libraryId, library.id));
  for (const file of failed) {
    const folder = rules.identify(file.path)?.canonicalFolder;
    if (folder !== undefined) paths.set(folder, paths.get(folder) ?? 0);
  }
  if (paths.size === 0) {
    await fanOutScanRun(db, job.id, new Map());
    await publishEvent(db, {
      kind: "library.changed",
      libraryId: library.id,
    });
    return;
  }
  const concurrencyKey = libraryConcurrencyKey(library.id);
  const folders = await db.transaction(async (tx) => {
    const queue = createJobQueue(tx);
    const childJobIds: string[] = [];
    const folders = new Map<string, number>();
    for (const [path, count] of paths) {
      const child = await enqueueScan(
        queue,
        {
          type: "scan",
          libraryId: library.id,
          path,
          reconcileMissing: true,
          runId: job.id,
        },
        { concurrencyKey },
      );
      childJobIds.push(child.id);
      folders.set(child.id, count);
    }
    await tx
      .update(jobs)
      .set({ payload: { ...payload, childJobIds } })
      .where(eq(jobs.id, job.id));
    return folders;
  });
  await fanOutScanRun(db, job.id, folders);
}
