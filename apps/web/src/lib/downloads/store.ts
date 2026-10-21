import { type Readable, writable } from "svelte/store";
import type { ItemDetail } from "../browse.ts";

export type DownloadState =
  | "queued"
  | "downloading"
  | "paused"
  | "failed"
  | "complete";
export type DownloadStream = ItemDetail["versions"][number]["streams"][number];
export type DownloadRecord = {
  itemId: string;
  versionId: string;
  title: string;
  bytes: number;
  container: string | null;
  streams: DownloadStream[];
  written: number;
  state: DownloadState;
  /** The server's ETag at the last response, or null for records written before it existed. */
  etag: string | null;
  /** The Item's stored subtitle files saved next to the media, each under `name`. */
  subtitles: DownloadSubtitle[];
};
/** A stored subtitle file of the Item, as the item detail lists it. */
export type ItemSubtitle = ItemDetail["subtitles"][number];
export type DownloadSubtitle = Omit<ItemSubtitle, "url"> & { name: string };
export type DownloadInput = Omit<
  DownloadRecord,
  "written" | "state" | "etag" | "subtitles"
> & { subtitles?: readonly ItemSubtitle[] };
export type DownloadsSnapshot = {
  ready: boolean;
  /** OPFS refused or threw: downloads are unusable here. */
  unavailable: boolean;
  records: DownloadRecord[];
  persisted: boolean | undefined;
  storage: { usage: number; quota: number; downloads: number } | undefined;
};
export type DownloadsDeps = {
  root: () => Promise<FileSystemDirectoryHandle>;
  open: (versionId: string) => Promise<DownloadFile>;
  fetch: typeof fetch;
  storage: Pick<StorageManager, "persist" | "persisted" | "estimate">;
  /** Serializes index reads-writes and Version transfers across tabs; absent means single-tab. */
  locks?: Pick<LockManager, "request">;
  /** Carries index-change, progress and control messages between tabs. */
  channel?: Pick<BroadcastChannel, "postMessage" | "addEventListener">;
};

/** One Version's file in browser storage, written in place. */
export type DownloadFile = {
  /** Bytes durably on disk now. */
  size(): Promise<number>;
  write(bytes: Uint8Array, at: number): Promise<void>;
  /** Makes everything written so far durable. */
  flush(): Promise<void>;
  truncate(size: number): Promise<void>;
  close(): Promise<void>;
};

export type Downloads = Readable<DownloadsSnapshot> & {
  restore(): Promise<void>;
  start(input: DownloadInput): Promise<void>;
  pause(versionId: string): Promise<void>;
  resume(versionId: string): Promise<void>;
  remove(versionId: string): Promise<void>;
  /**
   * A download's file read in place, with no copy: the media by its Version
   * id, a saved subtitle by its `name`.
   */
  file(name: string): Promise<File>;
};

const flushBytes = 8 * 1024 * 1024;
const flushMs = 2000;
const notifyMs = 250;
const indexLock = "thalia-downloads-index";
const fileLock = (versionId: string) => `thalia-download:${versionId}`;

type ChannelMessage =
  | { type: "changed" }
  | {
      type: "progress";
      versionId: string;
      written: number;
      bytes: number;
      state: DownloadState;
    }
  | { type: "pause" | "remove"; versionId: string };

/**
 * One OPFS-backed download queue: each Version's file lands under `downloads/`
 * named by its id, and `downloads/index.json` holds the records shared by all
 * tabs. Index writes are read-modify-write under the index lock so two tabs
 * never clobber each other's records; every transfer runs under a per-Version
 * lock so only one tab writes a file. The injected file writes in place and
 * flushes every 8 MiB or two seconds, keeping reload loss small without copies.
 */
export function createDownloads(deps: DownloadsDeps): Downloads {
  const store = writable<DownloadsSnapshot>({
    ready: false,
    unavailable: false,
    records: [],
    persisted: undefined,
    storage: undefined,
  });
  const records: DownloadRecord[] = [];
  let ready = false;
  let unavailable = false;
  let persisted: boolean | undefined;
  let askedPersist = false;
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
        /** The Version lock was another tab's: this tab writes nothing. */
        skipped: boolean;
        done: Promise<void>;
      }
    | undefined;

  // Records mutate in place; snapshots copy them so subscribers re-render.
  const notify = () =>
    store.set({
      ready,
      unavailable,
      records: records.map((record) => ({ ...record })),
      persisted,
      storage: estimated
        ? {
            usage,
            quota,
            downloads: records.reduce((sum, record) => sum + record.written, 0),
          }
        : undefined,
    });

  /** Tells other tabs how far this tab's transfer is, so their lists track it. */
  function postProgress(record: DownloadRecord): void {
    deps.channel?.postMessage({
      type: "progress",
      versionId: record.versionId,
      written: record.written,
      bytes: record.bytes,
      state: record.state,
    } satisfies ChannelMessage);
  }

  async function directory(): Promise<FileSystemDirectoryHandle> {
    return (await deps.root()).getDirectoryHandle("downloads", {
      create: true,
    });
  }

  // Index writes serialize on one same-tab chain, and the Web Locks entry
  // serializes them across tabs; neither alone is enough.
  let indexChain: Promise<void> = Promise.resolve();
  function locked<T>(name: string, run: () => Promise<T>): Promise<T> {
    if (deps.locks === undefined) return run();
    return deps.locks.request(name, run) as Promise<T>;
  }
  /** Runs `run` under `name` when free; `held` is false when another tab owns it. */
  function tryLocked<T>(
    name: string,
    run: (held: boolean) => Promise<T>,
  ): Promise<T> {
    if (deps.locks === undefined) return run(true);
    return deps.locks.request(name, { ifAvailable: true }, (lock) =>
      run(lock !== null),
    ) as Promise<T>;
  }

  /** Reads and validates the index; malformed entries are skipped, never fatal. */
  async function readIndex(): Promise<DownloadRecord[]> {
    try {
      const handle = await (await directory()).getFileHandle("index.json");
      const parsed: unknown = JSON.parse(await (await handle.getFile()).text());
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(
          (entry): entry is DownloadRecord =>
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as DownloadRecord).versionId === "string" &&
            typeof (entry as DownloadRecord).itemId === "string",
        )
        .map((entry) => ({
          ...entry,
          etag: typeof entry.etag === "string" ? entry.etag : null,
          subtitles: Array.isArray(entry.subtitles) ? entry.subtitles : [],
        }));
    } catch {
      return [];
    }
  }

  async function writeIndex(stored: DownloadRecord[]): Promise<void> {
    const handle = await (await directory()).getFileHandle("index.json", {
      create: true,
    });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(stored));
    await writable.close();
  }

  const upsertRecord = (stored: DownloadRecord[], record: DownloadRecord) => {
    const index = stored.findIndex(
      (entry) => entry.versionId === record.versionId,
    );
    if (index < 0) return [...stored, record];
    const next = [...stored];
    next[index] = record;
    return next;
  };

  /** Replaces memory with the shared index, keeping this tab's live transfer. */
  function sync(stored: DownloadRecord[]): void {
    records.length = 0;
    records.push(
      ...stored.map((entry) =>
        current?.record.versionId === entry.versionId
          ? current.record
          : { ...entry },
      ),
    );
    notify();
  }

  /**
   * Applies `change` to the stored index under the lock, writes it back, then
   * announces the change so other tabs resync.
   */
  function updateIndex(
    change: (stored: DownloadRecord[]) => DownloadRecord[],
  ): Promise<void> {
    indexChain = indexChain.then(() =>
      locked(indexLock, async () => {
        const next = change(await readIndex());
        await writeIndex(next);
        sync(next);
        deps.channel?.postMessage({ type: "changed" } satisfies ChannelMessage);
      }).catch(() => {}),
    );
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

  // Messages apply in arrival order: a "changed" resync finishes before the
  // progress update behind it, so a record is never missed between the two.
  let channelChain: Promise<void> = Promise.resolve();
  function handleMessage(message: ChannelMessage): Promise<void> {
    switch (message.type) {
      case "changed":
        return readIndex().then(sync);
      case "progress": {
        // This tab's own transfer counts its bytes itself.
        if (current?.record.versionId === message.versionId)
          return Promise.resolve();
        const record = records.find(
          (entry) => entry.versionId === message.versionId,
        );
        if (record === undefined) return Promise.resolve();
        record.written = message.written;
        record.bytes = message.bytes;
        record.state = message.state;
        notify();
        return Promise.resolve();
      }
      case "pause":
      case "remove":
        if (current?.record.versionId === message.versionId)
          return (message.type === "pause" ? pause : remove)(message.versionId);
        return Promise.resolve();
    }
  }
  deps.channel?.addEventListener("message", (event) => {
    const message = (event as MessageEvent).data as ChannelMessage;
    if (typeof message !== "object" || message === null) return;
    channelChain = channelChain
      .then(() => handleMessage(message))
      .catch(() => {});
  });

  let restorePromise: Promise<void> | undefined;
  /** Reads the index and reconciles each record with the file on disk; safe to call from every page. */
  function restore(): Promise<void> {
    if (restorePromise === undefined)
      restorePromise = (async () => {
        let dir: FileSystemDirectoryHandle;
        try {
          dir = await directory();
        } catch {
          unavailable = true;
          ready = true;
          notify();
          return;
        }
        for (const record of await readIndex()) {
          try {
            record.written = (
              await (await dir.getFileHandle(record.versionId)).getFile()
            ).size;
          } catch {
            record.written = 0;
          }
          if (record.state === "queued" || record.state === "downloading")
            record.state = "paused";
          records.push({ ...record });
        }
        try {
          persisted = await deps.storage.persisted();
        } catch {}
        await refreshEstimate();
        ready = true;
        notify();
      })();
    return restorePromise;
  }

  /** Queues a new record; the first download also asks the browser to keep it. */
  async function start(input: DownloadInput): Promise<void> {
    await restore();
    if (persisted !== true && !askedPersist) {
      askedPersist = true;
      try {
        persisted = await deps.storage.persist();
      } catch {
        persisted = false;
      }
    }
    if (records.some((record) => record.versionId === input.versionId)) return;
    const subtitles = await saveSubtitles(input);
    let added = false;
    await updateIndex((stored) => {
      if (stored.some((record) => record.versionId === input.versionId))
        return stored;
      added = true;
      return [
        ...stored,
        { ...input, subtitles, written: 0, state: "queued", etag: null },
      ];
    });
    if (added) void pump();
  }

  /**
   * Saves the Item's stored subtitle files next to the media as
   * `<versionId>.<track name>`. A file that fails to save is left out of
   * the record; the media downloads regardless.
   */
  async function saveSubtitles(
    input: DownloadInput,
  ): Promise<DownloadSubtitle[]> {
    const saved: DownloadSubtitle[] = [];
    for (const { url, ...track } of input.subtitles ?? []) {
      const name = `${input.versionId}.${url.slice(url.lastIndexOf("/") + 1)}`;
      try {
        const response = await deps.fetch(url, { credentials: "same-origin" });
        if (!response.ok) continue;
        const handle = await (await directory()).getFileHandle(name, {
          create: true,
        });
        const writable = await handle.createWritable();
        await writable.write(await response.blob());
        await writable.close();
        saved.push({ ...track, name });
      } catch (error) {
        console.error(error);
      }
    }
    return saved;
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
      skipped: false,
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
      if (!entry.skipped) postProgress(record);
      if (!entry.remove && !entry.skipped)
        await updateIndex((stored) => upsertRecord(stored, record));
      void pump();
    })();
    return entry.done;
  }

  async function transfer(
    record: DownloadRecord,
    entry: NonNullable<typeof current>,
  ): Promise<void> {
    await tryLocked(fileLock(record.versionId), async (held) => {
      if (!held) {
        // Another tab owns this file; leave it "downloading" locally so the
        // pump moves on, and let its progress messages keep this list true.
        // It must not write the index: the owner's record is newer.
        entry.skipped = true;
        record.state = "downloading";
        notify();
        return;
      }
      record.state = "downloading";
      notify();
      postProgress(record);
      const file = await deps.open(record.versionId);
      let offset = 0;
      let flushed = 0;
      let flushError: unknown;
      let flushChain = Promise.resolve();
      const flush = () => {
        flushChain = flushChain.then(async () => {
          const written = offset;
          await file.flush();
          flushed = written;
        });
        return flushChain;
      };
      const timer = setInterval(() => {
        void flush().catch((error: unknown) => {
          flushError = error;
          entry.controller.abort();
        });
      }, flushMs);
      const url = `/api/items/${record.itemId}/versions/${record.versionId}/download`;
      const ask = (from: number | null, etag: string | null) =>
        deps.fetch(url, {
          headers:
            from === null
              ? {}
              : {
                  range: `bytes=${from}-`,
                  ...(etag === null ? {} : { "if-range": etag }),
                },
          signal: entry.controller.signal,
          credentials: "same-origin",
        });
      try {
        offset = await file.size();
        flushed = offset;
        record.written = offset;
        const sentEtag = record.etag;
        let response = await ask(offset > 0 ? offset : null, sentEtag);
        let responseEtag = response.headers.get("etag");
        let range = response.headers.get("content-range");
        const matched =
          response.status === 206 &&
          range !== null &&
          range.startsWith(`bytes ${offset}-`) &&
          (sentEtag === null ||
            responseEtag === null ||
            responseEtag === sentEtag);
        if (response.status === 206 && !matched && offset > 0) {
          // A 206 we did not ask for, or one from different bytes: discard it
          // and take the whole file instead of splicing the tails.
          await response.body?.cancel();
          response = await ask(null, null);
          responseEtag = response.headers.get("etag");
          range = response.headers.get("content-range");
        }
        let total: number | null = null;
        if (matched && range !== null) {
          const slash = range.indexOf("/");
          if (slash >= 0) total = Number(range.slice(slash + 1));
        } else if (response.status === 200) {
          await file.truncate(0);
          offset = 0;
          flushed = 0;
          record.written = 0;
          // The old prefix must be gone on disk before its validator changes.
          // A crash between the index write and the first data flush is safe.
          await flush();
          record.etag = responseEtag;
          const length = response.headers.get("content-length");
          if (length !== null) total = Number(length);
          // No length means no known size: a chunked answer to a stale
          // If-Range. bytes 0 stands for unknown until the body ends.
          else record.bytes = 0;
        } else {
          // A 416 at exactly the file's size means the bytes all landed but
          // the index never recorded the completion.
          record.state =
            response.status === 416 && offset > 0 && offset === record.bytes
              ? "complete"
              : "failed";
          if (record.state === "complete") await refreshEstimate();
          notify();
          postProgress(record);
          return;
        }
        if (responseEtag !== null) record.etag = responseEtag;
        if (total !== null && Number.isFinite(total)) record.bytes = total;
        // Keep the validator even if the page closes before the next flush.
        await updateIndex((stored) => upsertRecord(stored, record));
        if (response.body === null)
          throw new Error("Download response has no body.");
        const reader = response.body.getReader();
        let lastNotify = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const length = value.byteLength;
          await file.write(value, offset);
          offset += length;
          record.written = offset;
          const now = Date.now();
          if (now - lastNotify >= notifyMs) {
            lastNotify = now;
            notify();
            postProgress(record);
          }
          if (offset - flushed >= flushBytes) await flush();
        }
        if (flushError !== undefined) throw flushError;
        await flush();
        // An unknown size means a clean end is the size.
        if (record.bytes === 0) record.bytes = record.written;
        record.state = record.written === record.bytes ? "complete" : "failed";
        if (record.state === "complete") await refreshEstimate();
        notify();
        postProgress(record);
      } catch (error) {
        entry.controller.abort();
        try {
          await flush();
        } catch {}
        if (entry.remove) return;
        record.state = entry.pause ? "paused" : "failed";
        notify();
        postProgress(record);
        if (error instanceof Error && !entry.pause && !entry.remove)
          console.error(error);
      } finally {
        clearInterval(timer);
        // Retry a failed periodic flush before releasing the exclusive handle.
        try {
          await flushChain;
        } finally {
          try {
            await file.flush();
          } finally {
            await file.close();
          }
        }
      }
    });
  }

  /** Stops a queued or running download, keeping its bytes for resume. */
  async function pause(versionId: string): Promise<void> {
    await restore();
    if (current?.record.versionId === versionId) {
      current.pause = true;
      current.controller.abort();
      await current.done;
      return;
    }
    const record = records.find((entry) => entry.versionId === versionId);
    if (record === undefined) return;
    if (record.state === "queued") {
      record.state = "paused";
      notify();
      await updateIndex((stored) =>
        stored.map((entry) =>
          entry.versionId === versionId ? { ...entry, state: "paused" } : entry,
        ),
      );
      return;
    }
    if (record.state !== "downloading") return;
    const held = await tryLocked(fileLock(versionId), async (held) => {
      if (!held) return false;
      record.state = "paused";
      notify();
      await updateIndex((stored) =>
        stored.map((entry) =>
          entry.versionId === versionId ? { ...entry, state: "paused" } : entry,
        ),
      );
      return true;
    });
    if (!held) {
      // Another tab owns the transfer; it pauses itself on the message.
      deps.channel?.postMessage({ type: "pause", versionId });
    }
  }

  /** Returns a paused or failed record to the queue. */
  async function resume(versionId: string): Promise<void> {
    await restore();
    const record = records.find((entry) => entry.versionId === versionId);
    if (
      record === undefined ||
      (record.state !== "paused" && record.state !== "failed")
    )
      return;
    // If the Version lock is held, another tab owns the transfer: resume is
    // not this tab's to write. Show it downloading and leave the index alone.
    // The queued write happens under the lock, so no tab can take it between.
    const held = await tryLocked(fileLock(versionId), async (held) => {
      if (!held) return false;
      record.state = "queued";
      notify();
      // Only the state field may move: another tab's entry can be newer.
      await updateIndex((stored) =>
        stored.map((entry) =>
          entry.versionId === versionId ? { ...entry, state: "queued" } : entry,
        ),
      );
      return true;
    });
    if (!held) {
      record.state = "downloading";
      notify();
      return;
    }
    void pump();
  }

  /** Cancels an unfinished download or deletes a finished one, file and record. */
  async function remove(versionId: string): Promise<void> {
    await restore();
    const find = () =>
      records.findIndex((entry) => entry.versionId === versionId);
    if (find() < 0) return;
    if (current?.record.versionId === versionId) {
      current.remove = true;
      current.controller.abort();
      await current.done;
    } else if (records[find()]?.state === "downloading") {
      const held = await tryLocked(fileLock(versionId), async (held) => held);
      if (!held) {
        deps.channel?.postMessage({ type: "remove", versionId });
        return;
      }
    }
    // The index may have changed while the transfer's `done` was awaited.
    const index = find();
    if (index < 0) return;
    const [removed] = records.splice(index, 1);
    for (const name of [
      versionId,
      ...(removed?.subtitles.map((track) => track.name) ?? []),
    ]) {
      try {
        await (await directory()).removeEntry(name);
      } catch {}
    }
    notify();
    await updateIndex((stored) =>
      stored.filter((entry) => entry.versionId !== versionId),
    );
    await refreshEstimate();
    notify();
  }

  async function file(name: string): Promise<File> {
    return (await (await directory()).getFileHandle(name)).getFile();
  }

  return {
    subscribe: store.subscribe,
    restore,
    start,
    pause,
    resume,
    remove,
    file,
  };
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
