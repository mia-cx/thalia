import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { type JobPayload, jobs, type ScanChange } from "../db/schema/index.ts";
import type { createJobQueue, Dedupe } from "../jobs/queue.ts";
import { rootedKey } from "./roots.ts";

type Queue = ReturnType<typeof createJobQueue>;
type EnqueueOptions = Parameters<Queue["enqueue"]>[1];

type ScanPayload = Extract<JobPayload, { type: "scan" }>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Retains queued move sources and passes their earlier provider assertions to the follow-up. Runs under the Library write lock. */
export async function queuedScanMoveSources(
  tx: Transaction,
  libraryId: string,
  changes: readonly ScanChange[],
) {
  const queued = await tx
    .select({ id: jobs.id, payload: jobs.payload })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, "scan"),
        eq(jobs.state, "queued"),
        sql`${jobs.payload}->>'libraryId' = ${libraryId}`,
      ),
    )
    .orderBy(jobs.id)
    .for("update");
  let assertions = scanAssertions(changes);
  const sources = new Set<string>();
  for (const { id, payload } of queued) {
    if (payload.type !== "scan") continue;
    const pending = payload.changes ?? [];
    const moved = new Set(
      pending.flatMap((change) =>
        change.kind === "move"
          ? [rootedKey({ rootId: change.rootId, path: change.previousPath })]
          : [],
      ),
    );
    for (const key of moved) sources.add(key);
    const carried = assertions.filter(
      (assertion) =>
        moved.has(rootedKey(assertion)) &&
        Object.keys(assertion.providerIds).length > 0,
    );
    // Earlier assertions precede the follow-up's changes, so its corrections
    // still win. Locking its row prevents an enqueue from losing either input.
    if (carried.length > 0)
      await tx
        .update(jobs)
        .set({ payload: { ...payload, changes: [...carried, ...pending] } })
        .where(eq(jobs.id, id));
    assertions = scanAssertions([...assertions, ...pending]);
  }
  return sources;
}

/** Retains provider assertions at their surviving destinations, in event arrival order. */
export function scanAssertions(changes: readonly ScanChange[]) {
  const assertions = new Map<string, Extract<ScanChange, { kind: "add" }>>();
  for (const change of changes) {
    const key = rootedKey(change);
    if (change.kind === "delete") {
      for (const [key, assertion] of assertions) {
        if (assertion.rootId !== change.rootId) continue;
        if (
          assertion.path === change.path ||
          (change.target === "item" &&
            (change.path === "." ||
              assertion.path.startsWith(`${change.path}/`)))
        )
          assertions.delete(key);
      }
      continue;
    }
    const previousKey =
      change.kind === "move"
        ? rootedKey({ rootId: change.rootId, path: change.previousPath })
        : key;
    const previous = assertions.get(previousKey);
    assertions.delete(previousKey);
    assertions.delete(key);
    assertions.set(key, {
      kind: "add",
      rootId: change.rootId,
      path: change.path,
      providerIds: { ...previous?.providerIds, ...change.providerIds },
    });
  }
  return [...assertions.values()];
}

/** A whole-Library scan fans out; children and explicit changes scan an Item folder, including `.`. */
export function isLibraryScan(
  payload: Pick<ScanPayload, "path" | "runId" | "changes">,
): boolean {
  return (
    payload.path === "." &&
    payload.runId === undefined &&
    payload.changes === undefined
  );
}

/**
 * The Dedupe that coalesces scan requests for one Library and scope, so a
 * whole-Library scan can still queue its own `.` folder child. Requests merge
 * their changes in arrival order into the queued follow-up; a running scan
 * covers only requests with no changes its reconcileMissing does not flag.
 */
export function scanDedupe(payload: ScanPayload): Dedupe {
  const scope = isLibraryScan(payload) ? "library" : "folder";
  return {
    key: `scan:${payload.libraryId}:${scope}:${payload.path}`,
    merge: (queued) => {
      if (queued.type !== "scan") return queued;
      const merged: ScanPayload = { ...queued };
      const changes = [...(queued.changes ?? []), ...(payload.changes ?? [])];
      if (changes.length > 0) merged.changes = changes;
      if (queued.reconcileMissing === true || payload.reconcileMissing === true)
        merged.reconcileMissing = true;
      return merged;
    },
    // Only a dead-but-retryable run covers a request: its reclaim re-walks
    // the disk with this input. A live scan may already hold a stale walk.
    coveredBy: (running) =>
      running.payload.type === "scan" &&
      running.leaseExpiresAt.getTime() <= Date.now() &&
      running.attempts < running.maxAttempts &&
      (payload.changes?.length ?? 0) === 0 &&
      (payload.reconcileMissing !== true ||
        running.payload.reconcileMissing === true),
  };
}

/** Enqueues a scan, coalescing it into an unsettled scan of the same scope. */
export function enqueueScan(
  queue: Queue,
  scan: ScanPayload,
  options: EnqueueOptions = {},
) {
  return queue.enqueue(scan, { ...options, dedupe: scanDedupe(scan) });
}
