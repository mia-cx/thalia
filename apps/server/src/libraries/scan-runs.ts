import { and, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { publishEvent } from "../api/events.ts";
import { server } from "../auth/access.ts";
import { requirePermission } from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import {
  files,
  jobs,
  type libraries,
  libraryRoots,
  scanFailures,
  scanRuns,
} from "../db/schema/index.ts";
import { scanScope } from "./scan.ts";

type Run = typeof scanRuns.$inferSelect;
type Medium = (typeof libraries.$inferSelect)["medium"];

/** Updates to one run closer together than this publish no event; the run's end always does. */
export const scanEventIntervalMs = 1000;

const toScanRun = ({ pending: _, publishedAt: __, ...run }: Run) => ({
  ...run,
  startedAt: run.startedAt.toISOString(),
  finishedAt: run.finishedAt === null ? null : run.finishedAt.toISOString(),
});

/** Publishes a run, throttled unless `always`; the throttle stamp is the run's own. */
async function publishRun(db: Database, id: string, always = false) {
  const [run] = await db
    .update(scanRuns)
    .set({ publishedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(scanRuns.id, id),
        always
          ? undefined
          : sql`${scanRuns.publishedAt} <= clock_timestamp() - ${scanEventIntervalMs} * interval '1 millisecond'`,
      ),
    )
    .returning();
  if (run !== undefined)
    await publishEvent(db, { kind: "scan.progress", run: toScanRun(run) });
}

/** Opens the run a whole-Library scan job leads; a retried job starts its run over. */
export async function startScanRun(
  db: Database,
  libraryId: string,
  runId: string,
) {
  const fresh = {
    state: "running" as const,
    total: 0,
    checked: 0,
    added: 0,
    changed: 0,
    removed: 0,
    unreadable: 0,
    pending: {},
    currentFolder: null,
    error: null,
    startedAt: sql`clock_timestamp()`,
    finishedAt: null,
  };
  await db
    .insert(scanRuns)
    .values({ id: runId, libraryId, ...fresh })
    .onConflictDoUpdate({ target: scanRuns.id, set: fresh });
  await publishRun(db, runId, true);
}

/** Records the folder jobs a run fanned out to and the files each folder holds. */
export async function fanOutScanRun(
  db: Database,
  runId: string,
  folders: ReadonlyMap<string, number>,
) {
  let total = 0;
  for (const count of folders.values()) total += count;
  await db
    .update(scanRuns)
    .set({ pending: Object.fromEntries(folders), total })
    .where(eq(scanRuns.id, runId));
  if (folders.size === 0)
    await db
      .update(scanRuns)
      .set({ state: "completed", finishedAt: sql`clock_timestamp()` })
      .where(eq(scanRuns.id, runId));
  await publishRun(db, runId, folders.size === 0);
}

/** The files a folder scan answers for, keyed by root and path, plus how many it skipped. */
async function folderFiles(
  db: Database,
  libraryId: string,
  medium: Medium,
  folder: string,
) {
  const { rules } = scanScope(medium);
  const inFolder = (path: string) =>
    rules.identify(path)?.canonicalFolder === folder;
  // LIKE wildcards in a folder name only widen the match; identify narrows it.
  const near = (column: AnyPgColumn) =>
    folder === "."
      ? undefined
      : or(eq(column, folder), like(column, `${folder}/%`));
  const rows = await db
    .select({
      rootId: files.rootId,
      path: files.path,
      bytes: files.bytes,
      modifiedAt: files.modifiedAt,
    })
    .from(files)
    .where(and(eq(files.libraryId, libraryId), near(files.path)));
  const skipped = await db
    .select({ path: scanFailures.path })
    .from(scanFailures)
    .innerJoin(libraryRoots, eq(libraryRoots.id, scanFailures.rootId))
    .where(and(eq(libraryRoots.libraryId, libraryId), near(scanFailures.path)));
  return {
    files: new Map(
      rows
        .filter((row) => inFolder(row.path))
        .map((row) => [
          `${row.rootId}\0${row.path}`,
          `${row.bytes}:${row.modifiedAt.getTime()}`,
        ]),
    ),
    skipped: skipped.filter((row) => inFolder(row.path)).length,
  };
}

/** The running runs still waiting on a folder job. */
async function runsAwaiting(db: Database, jobId: string) {
  const rows = await db
    .select({ id: scanRuns.id })
    .from(scanRuns)
    .where(
      and(eq(scanRuns.state, "running"), sql`${scanRuns.pending} ? ${jobId}`),
    );
  return rows.map((row) => row.id);
}

/**
 * Starts counting a folder scan toward every run waiting on its job, or
 * returns undefined when none is. `finish`, called once the scan wrote,
 * adds the files it added, changed and removed, the ones it couldn't read,
 * and its share of each run's total.
 */
export async function countFolderScan(
  db: Database,
  library: { id: string; medium: Medium },
  jobId: string,
  folder: string,
) {
  const waiting = await runsAwaiting(db, jobId);
  if (waiting.length === 0) return undefined;
  await db
    .update(scanRuns)
    .set({ currentFolder: folder })
    .where(inArray(scanRuns.id, waiting));
  for (const id of waiting) await publishRun(db, id);
  const before = await folderFiles(db, library.id, library.medium, folder);
  return {
    async finish() {
      const after = await folderFiles(db, library.id, library.medium, folder);
      let added = 0;
      let changed = 0;
      for (const [key, stamp] of after.files) {
        const previous = before.files.get(key);
        if (previous === undefined) added += 1;
        else if (previous !== stamp) changed += 1;
      }
      let removed = 0;
      for (const key of before.files.keys())
        if (!after.files.has(key)) removed += 1;
      const checked = after.files.size + after.skipped;
      await db
        .update(scanRuns)
        .set({
          checked: sql`${scanRuns.checked} + ${checked}`,
          total: sql`greatest(${scanRuns.total}, ${scanRuns.checked} + ${checked})`,
          added: sql`${scanRuns.added} + ${added}`,
          changed: sql`${scanRuns.changed} + ${changed}`,
          removed: sql`${scanRuns.removed} + ${removed}`,
          unreadable: sql`${scanRuns.unreadable} + ${after.skipped}`,
          pending: sql`${scanRuns.pending} - ${jobId}::text`,
        })
        .where(inArray(scanRuns.id, waiting));
      await finishScanRuns(db, waiting);
      for (const id of waiting) await publishRun(db, id);
    },
  };
}

/** Records a scan job's final failure against the runs it leads or that wait on it. */
export async function failScanJob(db: Database, jobId: string, error: string) {
  const waiting = [...new Set([jobId, ...(await runsAwaiting(db, jobId))])];
  await db
    .update(scanRuns)
    .set({ error, pending: sql`${scanRuns.pending} - ${jobId}::text` })
    .where(and(inArray(scanRuns.id, waiting), eq(scanRuns.state, "running")));
  await finishScanRuns(db, waiting, [jobId]);
}

/**
 * Ends the given runs that have nothing left to wait for. A run fails when
 * its job or a folder job failed, and is interrupted when a folder job ended
 * without counting, as when a restart lost it on its last attempt.
 */
async function finishScanRuns(
  db: Database,
  ids: readonly string[],
  failedJobIds: readonly string[] = [],
) {
  if (ids.length === 0) return;
  const runs = await db
    .select()
    .from(scanRuns)
    .where(and(inArray(scanRuns.id, [...ids]), eq(scanRuns.state, "running")));
  for (const run of runs) {
    const pending = Object.keys(run.pending);
    const jobRows = await db
      .select({ id: jobs.id, state: jobs.state, error: jobs.error })
      .from(jobs)
      .where(inArray(jobs.id, [run.id, ...pending]));
    const job = (id: string) => {
      const row = jobRows.find((row) => row.id === id);
      return failedJobIds.includes(id) && row !== undefined
        ? { ...row, state: "failed" as const }
        : row;
    };
    const live = [run.id, ...pending].some((id) => {
      const state = job(id)?.state;
      return state === "queued" || state === "running";
    });
    if (live) continue;
    const failed = [run.id, ...pending].find(
      (id) => job(id)?.state === "failed",
    );
    const error =
      run.error ?? (failed === undefined ? null : (job(failed)?.error ?? ""));
    const state =
      error !== null
        ? "failed"
        : pending.length > 0
          ? "interrupted"
          : "completed";
    await db
      .update(scanRuns)
      .set({
        state,
        error,
        currentFolder: null,
        finishedAt: sql`clock_timestamp()`,
      })
      .where(and(eq(scanRuns.id, run.id), eq(scanRuns.state, "running")));
    await publishRun(db, run.id, true);
  }
}

/** Settles every running run whose jobs ended without reporting, as after a restart. */
export async function reconcileScanRuns(db: Database) {
  const running = await db
    .select({ id: scanRuns.id })
    .from(scanRuns)
    .where(eq(scanRuns.state, "running"));
  await finishScanRuns(
    db,
    running.map((run) => run.id),
  );
}

/** Each Library's newest run, for a caller holding libraries:manage. */
export async function latestScanRuns(db: Database, actorId: string) {
  await requirePermission(db, actorId, "libraries:manage", server);
  await reconcileScanRuns(db);
  const rows = await db
    .selectDistinctOn([scanRuns.libraryId])
    .from(scanRuns)
    .orderBy(scanRuns.libraryId, desc(scanRuns.startedAt))
    .limit(1000);
  return rows.map(toScanRun);
}
