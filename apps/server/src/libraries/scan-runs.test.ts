import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { setupAdmin } from "../auth/accounts.ts";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { events, jobs } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createJobQueue } from "../jobs/queue.ts";
import { createJobRegistry } from "../jobs/registry.ts";
import { createVideoFixture } from "../mediums/video-common/fixtures.ts";
import { libraryConcurrencyKey, registerLibraryJobs } from "./jobs.ts";
import { latestScanRuns, reconcileScanRuns } from "./scan-runs.ts";
import { insertLibraries } from "./testing.ts";

async function withTempRoot<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "thalia-runs-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function setup(db: Database, root: string) {
  await migrateDatabase(db);
  const admin = await setupAdmin(db, { username: "admin", password: "pw" });
  const [library] = await insertLibraries(db, {
    name: "Movies",
    medium: "movies",
    rootPath: root,
  });
  if (!library) throw new Error("Library insert returned no row.");
  return { admin, library };
}

/** Runs a whole-Library scan the way a worker does, until no scan job is left. */
async function scanAll(db: Database, libraryId: string, maxAttempts = 3) {
  const queue = createJobQueue(db);
  const registry = createJobRegistry();
  registerLibraryJobs(db, registry);
  const root = await queue.enqueue(
    { type: "scan", libraryId, path: "." },
    { concurrencyKey: libraryConcurrencyKey(libraryId), maxAttempts },
  );
  for (;;) {
    const job = await queue.claim(["scan"]);
    if (!job) break;
    try {
      await registry.run(job);
      await queue.complete(job);
    } catch (error) {
      await queue.fail(job, error);
    }
  }
  return root.id;
}

async function writeMovie(root: string, path: string) {
  await mkdir(join(root, path, ".."), { recursive: true });
  await createVideoFixture(join(root, path));
}

describe.skipIf(!databaseUrl)("scan runs", () => {
  test("a run counts new, changed, removed and unreadable files and stays as the last scan", () =>
    withDatabase((db) =>
      withTempRoot(async (root) => {
        const { admin, library } = await setup(db, root);
        await writeMovie(root, "Alien (1979)/Alien.mkv");
        await writeMovie(root, "Heat (1995)/Heat.mkv");
        await mkdir(join(root, "Broken (2001)"));
        await writeFile(join(root, "Broken (2001)/Broken.mkv"), "dummy");

        const first = await scanAll(db, library.id);
        expect(await latestScanRuns(db, admin.id)).toMatchObject([
          {
            id: first,
            libraryId: library.id,
            state: "completed",
            total: 3,
            checked: 3,
            added: 2,
            changed: 0,
            removed: 0,
            unmatched: 1,
            currentFolder: null,
            error: null,
          },
        ]);

        await rm(join(root, "Alien (1979)"), { recursive: true });
        await appendFile(join(root, "Heat (1995)/Heat.mkv"), "more");
        await writeMovie(root, "Arrival (2016)/Arrival.mkv");
        const second = await scanAll(db, library.id);
        const [run] = await latestScanRuns(db, admin.id);
        expect(run).toMatchObject({
          id: second,
          state: "completed",
          total: 3,
          checked: 3,
          added: 1,
          changed: 1,
          removed: 1,
          unmatched: 1,
        });
        expect(
          new Date(run?.finishedAt ?? "").getTime() -
            new Date(run?.startedAt ?? "").getTime(),
        ).toBeGreaterThanOrEqual(0);
      }),
    ));

  test("a fast scan publishes far fewer events than it scans folders, ending on the result", () =>
    withDatabase((db) =>
      withTempRoot(async (root) => {
        const { library } = await setup(db, root);
        const folders = 30;
        for (let i = 0; i < folders; i++) {
          await mkdir(join(root, `Movie ${i} (2000)`));
          await writeFile(join(root, `Movie ${i} (2000)/m.mkv`), "dummy");
        }
        await scanAll(db, library.id);
        const published = await db
          .select({ payload: events.payload })
          .from(events)
          .where(eq(events.kind, "scan.progress"))
          .orderBy(events.id);
        expect(published.length).toBeLessThan(folders);
        expect(published.at(-1)?.payload).toMatchObject({
          run: { state: "completed", checked: folders, unmatched: folders },
        });
      }),
    ));

  test("a scan that can't read its library fails and says why", () =>
    withDatabase((db) =>
      withTempRoot(async (root) => {
        const { admin, library } = await setup(db, join(root, "gone"));
        await scanAll(db, library.id, 1);
        const [run] = await latestScanRuns(db, admin.id);
        expect(run?.state).toBe("failed");
        expect(run?.error).toBeTruthy();
      }),
    ));

  test("after a restart a run resumes while its jobs live and settles once they ended", () =>
    withDatabase((db) =>
      withTempRoot(async (root) => {
        const { admin, library } = await setup(db, root);
        await writeMovie(root, "Alien (1979)/Alien.mkv");
        const queue = createJobQueue(db);
        const registry = createJobRegistry();
        registerLibraryJobs(db, registry);
        await queue.enqueue(
          { type: "scan", libraryId: library.id, path: "." },
          { concurrencyKey: libraryConcurrencyKey(library.id) },
        );
        const rootJob = await queue.claim(["scan"]);
        if (!rootJob) throw new Error("No root job.");
        await registry.run(rootJob);
        await queue.complete(rootJob);

        // The folder job is still queued: the run resumes.
        await reconcileScanRuns(db);
        expect((await latestScanRuns(db, admin.id))[0]?.state).toBe("running");

        // Its holder died on the last attempt, so the queue failed it unseen.
        await db
          .update(jobs)
          .set({ state: "failed", error: "Job lease expired." })
          .where(eq(jobs.state, "queued"));
        await reconcileScanRuns(db);
        expect((await latestScanRuns(db, admin.id))[0]).toMatchObject({
          state: "failed",
          error: "Job lease expired.",
        });
      }),
    ));

  test("only library managers read scan runs", () =>
    withDatabase((db) =>
      withTempRoot(async (root) => {
        await setup(db, root);
        await expect(
          latestScanRuns(db, "00000000-0000-7000-8000-000000000000"),
        ).rejects.toBeInstanceOf(AuthError);
      }),
    ));
});
