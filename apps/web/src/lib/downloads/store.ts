import { type Readable, writable } from "svelte/store";
import type { ItemDetail } from "../browse.ts";

export type DownloadState =
  | "queued"
  | "downloading"
  | "paused"
  | "failed"
  | "complete";
export type DownloadStream =
  ItemDetail["versions"][number]["streams"][number];
export type DownloadRecord = {
  itemId: string;
  versionId: string;
  title: string;
  bytes: number;
  container: string | null;
  streams: DownloadStream[];
  written: number;
  state: DownloadState;
};
export type DownloadsSnapshot = {
  ready: boolean;
  records: DownloadRecord[];
  persisted: boolean | undefined;
  storage:
    | { usage: number; quota: number; downloads: number }
    | undefined;
};
export type DownloadsDeps = {
  root: () => Promise<FileSystemDirectoryHandle>;
  fetch: typeof fetch;
  storage: Pick<StorageManager, "persist" | "persisted" | "estimate">;
  commitBytes?: number;
};

export type Downloads = Readable<DownloadsSnapshot> & {
  restore(): Promise<void>;
  start(input: Omit<DownloadRecord, "written" | "state">): Promise<void>;
  pause(versionId: string): Promise<void>;
  resume(versionId: string): Promise<void>;
  remove(versionId: string): Promise<void>;
};

const defaultCommitBytes = 64 * 1024 * 1024;
const notifyMs = 250;

/**
 * One OPFS-backed download queue: each Version's file lands under `downloads/`
 * named by its id, and `downloads/index.json` holds the records. OPFS
 * writables land only on close, so a long transfer commits by closing and
 * reopening with `keepExistingData`, keeping the re-copy near one file size.
 */
export function createDownloads(deps: DownloadsDeps): Downloads {
  const commitBytes = deps.commitBytes ?? defaultCommitBytes;
  const store = writable<DownloadsSnapshot>({
    ready: false,
    records: [],
    persisted: undefined,
    storage: undefined,
  });
  const records: DownloadRecord[] = [];
  let ready = false;
  let persisted: boolean | undefined;
  let usage = 0;
  let quota = 0;
  let estimated = false;
  let pumping = false;
  let current:
    | {
        record: DownloadRecord;
        controller: AbortController;
        pause: boolean;
        remove: boolean;
        done: Promise<void>;
      }
    | undefined;

  const notify = () =>
    store.set({
      ready,
      records: [...records],
      persisted,
      storage: estimated
        ? {
            usage,
            quota,
            downloads: records.reduce((sum, record) => sum + record.written, 0),
          }
        : undefined,
    });

  async function directory(): Promise<FileSystemDirectoryHandle> {
    return (await deps.root()).getDirectoryHandle("downloads", {
      create: true,
    });
  }

  // Index writes serialize on one chain so a record update can never pass a
  // commit write still in flight.
  let indexChain: Promise<void> = Promise.resolve();
  function persistIndex(): Promise<void> {
    indexChain = indexChain
      .then(async () => {
        const handle = await (
          await directory()
        ).getFileHandle("index.json", { create: true });
        const writable = await handle.createWritable();
        await writable.write(JSON.stringify(records));
        await writable.close();
      })
      .catch(() => {});
    return indexChain;
  }

  async function refreshEstimate() {
    try {
      const estimate = await deps.storage.estimate();
      usage = estimate.usage ?? 0;
      quota = estimate.quota ?? 0;
      estimated = true;
    } catch {}
  }

  let restorePromise: Promise<void> | undefined;
  /** Reads the index and reconciles each record with the file on disk; safe to call from every page. */
  function restore(): Promise<void> {
    return (restorePromise ??= (async () => {
      const dir = await directory();
      let stored: DownloadRecord[] = [];
      try {
        const handle = await dir.getFileHandle("index.json");
        const parsed: unknown = JSON.parse(
          await (await handle.getFile()).text(),
        );
        if (Array.isArray(parsed)) stored = parsed as DownloadRecord[];
      } catch {}
      for (const record of stored) {
        let size = 0;
        try {
          size = (
            await (
              await dir.getFileHandle(record.versionId)
            ).getFile()
          ).size;
        } catch {}
        record.written = size;
        if (record.state === "queued" || record.state === "downloading")
          record.state = "paused";
        records.push(record);
      }
      try {
        persisted = await deps.storage.persisted();
      } catch {}
      await refreshEstimate();
      ready = true;
      notify();
    })());
  }

  /** Queues a new record; the first download also asks the browser to keep it. */
  async function start(
    input: Omit<DownloadRecord, "written" | "state">,
  ): Promise<void> {
    if (records.some((record) => record.versionId === input.versionId)) return;
    if (persisted === undefined) {
      try {
        persisted = await deps.storage.persist();
      } catch {
        persisted = false;
      }
    }
    records.push({ ...input, written: 0, state: "queued" });
    notify();
    await persistIndex();
    void pump();
  }

  function pump(): Promise<void> {
    if (pumping) return Promise.resolve();
    const record = records.find((entry) => entry.state === "queued");
    if (record === undefined) return Promise.resolve();
    pumping = true;
    const entry = {
      record,
      controller: new AbortController(),
      pause: false,
      remove: false,
      done: Promise.resolve(),
    };
    current = entry;
    entry.done = (async () => {
      try {
        await transfer(record, entry);
      } catch {
        record.state = "failed";
      }
      current = undefined;
      pumping = false;
      notify();
      await persistIndex();
      void pump();
    })();
    return entry.done;
  }

  async function transfer(
    record: DownloadRecord,
    entry: NonNullable<typeof current>,
  ): Promise<void> {
    record.state = "downloading";
    notify();
    const dir = await directory();
    const handle = await dir.getFileHandle(record.versionId, {
      create: true,
    });
    let offset = (await handle.getFile()).size;
    record.written = offset;
    let writable = await handle.createWritable({ keepExistingData: true });
    try {
      const response = await deps.fetch(
        `/api/items/${record.itemId}/versions/${record.versionId}/download`,
        {
          headers: offset > 0 ? { range: `bytes=${offset}-` } : {},
          signal: entry.controller.signal,
          credentials: "same-origin",
        },
      );
      const range = response.headers.get("content-range");
      let total: number | null = null;
      if (
        response.status === 206 &&
        range !== null &&
        range.startsWith(`bytes ${offset}-`)
      ) {
        await writable.seek(offset);
        const slash = range.indexOf("/");
        if (slash >= 0) total = Number(range.slice(slash + 1));
      } else if (response.status === 200 || response.status === 206) {
        await writable.truncate(0);
        offset = 0;
        record.written = 0;
        const length = response.headers.get("content-length");
        if (length !== null) total = Number(length);
      } else {
        await writable.close();
        record.state = "failed";
        notify();
        return;
      }
      if (total !== null && Number.isFinite(total)) record.bytes = total;
      if (response.body === null)
        throw new Error("Download response has no body.");
      const reader = response.body.getReader();
      let committed = record.written;
      let lastNotify = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value);
        record.written += value.byteLength;
        const now = Date.now();
        if (now - lastNotify >= notifyMs) {
          lastNotify = now;
          notify();
        }
        if (record.written - committed >= Math.max(commitBytes, committed)) {
          await writable.close();
          committed = record.written;
          await persistIndex();
          writable = await handle.createWritable({ keepExistingData: true });
          await writable.seek(committed);
        }
      }
      await writable.close();
      record.state =
        record.bytes === 0 || record.written === record.bytes
          ? "complete"
          : "failed";
      if (record.state === "complete") await refreshEstimate();
      notify();
    } catch (error) {
      try {
        await writable.close();
      } catch {}
      if (entry.remove) return;
      record.state = entry.pause ? "paused" : "failed";
      notify();
      if (error instanceof Error && !entry.pause && !entry.remove)
        console.error(error);
    }
  }

  /** Stops a queued or running download, keeping its bytes for resume. */
  async function pause(versionId: string): Promise<void> {
    if (current?.record.versionId === versionId) {
      current.pause = true;
      current.controller.abort();
      await current.done;
      return;
    }
    const record = records.find((entry) => entry.versionId === versionId);
    if (record === undefined || record.state !== "queued") return;
    record.state = "paused";
    notify();
    await persistIndex();
  }

  /** Returns a paused or failed record to the queue. */
  async function resume(versionId: string): Promise<void> {
    const record = records.find((entry) => entry.versionId === versionId);
    if (
      record === undefined ||
      (record.state !== "paused" && record.state !== "failed")
    )
      return;
    record.state = "queued";
    notify();
    await persistIndex();
    void pump();
  }

  /** Cancels an unfinished download or deletes a finished one, file and record. */
  async function remove(versionId: string): Promise<void> {
    const index = records.findIndex(
      (entry) => entry.versionId === versionId,
    );
    if (index < 0) return;
    if (current?.record.versionId === versionId) {
      current.remove = true;
      current.controller.abort();
      await current.done;
    }
    records.splice(index, 1);
    try {
      await (await directory()).removeEntry(versionId);
    } catch {}
    notify();
    await persistIndex();
    await refreshEstimate();
    notify();
  }

  return { subscribe: store.subscribe, restore, start, pause, resume, remove };
}

/** Whether this browser exposes the OPFS root downloads need. */
export function downloadsSupported(): boolean {
  const storage = (
    globalThis.navigator as
      | (Navigator & { storage?: { getDirectory?: unknown } })
      | undefined
  )?.storage;
  return typeof storage?.getDirectory === "function";
}
