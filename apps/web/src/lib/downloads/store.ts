import { type Readable, writable } from "svelte/store";
import type { ItemDetail } from "../browse.ts";
import { artworkFolder, offlineArtwork } from "./artwork.ts";
import {
  copyInto,
  fileNameFor,
  freeName,
  readManifest,
  writeManifest,
} from "./folder.ts";

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
  /** The Item as its page showed it at download time, which offline pages draw from; null on older records. */
  detail: ItemDetail | null;
  /** The file's name in the linked folder on disk; null while it is in browser storage. */
  fileName: string | null;
};
/** A stored subtitle file of the Item, as the item detail lists it. */
export type ItemSubtitle = ItemDetail["subtitles"][number];
export type DownloadSubtitle = Omit<ItemSubtitle, "url"> & { name: string };
export type DownloadInput = Omit<
  DownloadRecord,
  "written" | "state" | "etag" | "subtitles" | "fileName"
> & { subtitles?: readonly ItemSubtitle[] };
export type DownloadsSnapshot = {
  ready: boolean;
  /** OPFS refused or threw: downloads are unusable here. */
  unavailable: boolean;
  records: DownloadRecord[];
  /** Version ids whose file is being moved between browser storage and the folder. */
  moving: string[];
  persisted: boolean | undefined;
  /** Browser storage only: files in the linked folder use none of it. */
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
  /** The linked folder on disk, when one is linked and the browser grants access now. */
  folder?: () => Promise<FileSystemDirectoryHandle | undefined>;
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
  /** Moves a finished download's file into the linked folder or back into browser storage. */
  move(versionId: string, to: "folder" | "browser"): Promise<void>;
  /** Lists the downloads a newly linked or newly allowed folder already holds. */
  adopt(): Promise<void>;
  /** Drops the folder's downloads from the list after the folder is unlinked; the files stay on disk. */
  release(): Promise<void>;
  /**
   * A download's file read in place, with no copy, wherever it is kept: the
   * media by its Version id, a saved subtitle by its `name`.
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

/** Reads stored records, skipping malformed entries and filling fields older records lack. */
function parseRecords(parsed: unknown): DownloadRecord[] {
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
      detail:
        typeof entry.detail === "object" && entry.detail !== null
          ? entry.detail
          : null,
      fileName: typeof entry.fileName === "string" ? entry.fileName : null,
    }));
}

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
    moving: [],
    persisted: undefined,
    storage: undefined,
  });
  const records: DownloadRecord[] = [];
  const moving = new Set<string>();
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
      moving: [...moving],
      persisted,
      storage: estimated
        ? {
            usage,
            quota,
            downloads: records.reduce(
              (sum, record) =>
                record.fileName === null ? sum + record.written : sum,
              0,
            ),
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
      return parseRecords(JSON.parse(await (await handle.getFile()).text()));
    } catch {
      return [];
    }
  }

  /** Writes the index, and mirrors the folder's records into its manifest when the folder is at hand. */
  async function writeIndex(stored: DownloadRecord[]): Promise<void> {
    const handle = await (await directory()).getFileHandle("index.json", {
      create: true,
    });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(stored));
    await writable.close();
    try {
      const folder = await deps.folder?.();
      if (folder !== undefined)
        await writeManifest(
          folder,
          stored.filter((record) => record.fileName !== null),
        );
    } catch {
      // The index stays the truth; the manifest catches up on the next write.
    }
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
   * Applies `change` to the stored index under the lock, writes it back, runs
   * `after` on the result while still holding the lock, then announces the
   * change so other tabs resync.
   */
  function updateIndex(
    change: (stored: DownloadRecord[]) => DownloadRecord[],
    after?: (next: DownloadRecord[]) => Promise<void>,
  ): Promise<void> {
    indexChain = indexChain.then(() =>
      locked(indexLock, async () => {
        const next = change(await readIndex());
        await writeIndex(next);
        await after?.(next);
        sync(next);
        deps.channel?.postMessage({ type: "changed" } satisfies ChannelMessage);
      }).catch(() => {}),
    );
    return indexChain;
  }

  /**
   * Saves the artwork a record's offline pages draw, skipping what an earlier
   * attempt or a sibling Episode already saved. Missing artwork never fails
   * a download: its pages fall back to the title's colour.
   */
  async function saveArtwork(
    record: DownloadRecord,
    signal: AbortSignal,
  ): Promise<void> {
    if (record.detail === null) return;
    const folder = await artworkFolder(await directory(), true);
    for (const { id, url } of offlineArtwork(record.detail)) {
      if (signal.aborted) return;
      try {
        await folder.getFileHandle(id);
        continue;
      } catch {}
      try {
        const response = await deps.fetch(url, {
          signal,
          credentials: "same-origin",
        });
        if (!response.ok) continue;
        const bytes = await response.arrayBuffer();
        // A writable lands its bytes only on close, so a cut-off save leaves no file.
        const writable = await (
          await folder.getFileHandle(id, { create: true })
        ).createWritable();
        await writable.write(bytes);
        await writable.close();
      } catch {}
    }
  }

  /** Deletes a removed record's artwork that no remaining record draws. */
  async function dropArtwork(
    removed: DownloadRecord,
    remaining: DownloadRecord[],
  ): Promise<void> {
    if (removed.detail === null) return;
    const kept = new Set(
      remaining.flatMap((record) =>
        record.detail === null
          ? []
          : offlineArtwork(record.detail).map((art) => art.id),
      ),
    );
    try {
      const folder = await artworkFolder(await directory());
      for (const { id } of offlineArtwork(removed.detail))
        if (!kept.has(id)) await folder.removeEntry(id).catch(() => {});
    } catch {}
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
          if (record.fileName !== null) {
            // A move cut off after its index write can leave the old copy.
            await dir.removeEntry(record.versionId).catch(() => {});
            records.push({ ...record });
            continue;
          }
          try {
            record.written = (
              await (await dir.getFileHandle(record.versionId)).getFile()
            ).size;
          } catch {
            record.written = 0;
          }
          // A page closed right after the last byte can leave the index a
          // step behind: a whole file on disk is a finished download.
          if (record.state === "queued" || record.state === "downloading")
            record.state =
              record.bytes > 0 && record.written === record.bytes
                ? "complete"
                : "paused";
          records.push({ ...record });
        }
        try {
          persisted = await deps.storage.persisted();
        } catch {}
        await refreshEstimate();
        ready = true;
        notify();
        await adoptFolder();
      })();
    return restorePromise;
  }

  /**
   * Adds the downloads the linked folder's manifest lists and the index
   * lacks, such as those from an earlier session, when their files are
   * there whole.
   */
  async function adoptFolder(): Promise<void> {
    const folder = await deps.folder?.().catch(() => undefined);
    if (folder === undefined) return;
    const found: DownloadRecord[] = [];
    for (const entry of parseRecords(await readManifest(folder))) {
      if (entry.fileName === null) continue;
      try {
        const file = await (
          await folder.getFileHandle(entry.fileName)
        ).getFile();
        if (file.size !== entry.bytes) continue;
      } catch {
        continue;
      }
      found.push({ ...entry, written: entry.bytes, state: "complete" });
    }
    if (found.length === 0) return;
    await updateIndex((stored) => [
      ...stored,
      ...found.filter(
        (entry) =>
          !stored.some((record) => record.versionId === entry.versionId),
      ),
    ]);
  }

  async function adopt(): Promise<void> {
    await restore();
    await adoptFolder();
  }

  async function release(): Promise<void> {
    await restore();
    await updateIndex((stored) =>
      stored.filter((record) => record.fileName === null),
    );
  }

  /** A download's file, from the linked folder or browser storage; saved subtitles stay in browser storage. */
  async function file(name: string): Promise<File> {
    await restore();
    const fileName =
      records.find((entry) => entry.versionId === name)?.fileName ?? null;
    if (fileName === null)
      return (await (await directory()).getFileHandle(name)).getFile();
    const folder = await deps.folder?.();
    if (folder === undefined)
      throw new Error("The download folder needs access.");
    return (await folder.getFileHandle(fileName)).getFile();
  }

  /**
   * Copies a finished download's file to the other place, records the new
   * place, then deletes the old copy, under its Version lock so no transfer
   * or other move touches it meanwhile. A failed copy keeps the original.
   */
  async function move(versionId: string, to: "folder" | "browser") {
    await restore();
    const record = records.find((entry) => entry.versionId === versionId);
    if (
      record === undefined ||
      record.state !== "complete" ||
      (record.fileName === null) === (to === "browser") ||
      moving.has(versionId)
    )
      return;
    const folder = await deps.folder?.();
    if (folder === undefined)
      throw new Error("The download folder needs access.");
    const dir = await directory();
    moving.add(versionId);
    notify();
    try {
      await locked(fileLock(versionId), async () => {
        if (to === "folder") {
          const name = await freeName(folder, fileNameFor(record));
          await copyInto(
            await (await dir.getFileHandle(versionId)).getFile(),
            folder,
            name,
          );
          await setFileName(versionId, name);
          await dir.removeEntry(versionId);
        } else {
          const name = record.fileName ?? "";
          await copyInto(
            await (await folder.getFileHandle(name)).getFile(),
            dir,
            versionId,
          );
          await setFileName(versionId, null);
          await folder.removeEntry(name);
        }
      });
    } finally {
      moving.delete(versionId);
      await refreshEstimate();
      notify();
    }
  }

  async function setFileName(versionId: string, fileName: string | null) {
    await updateIndex((stored) =>
      stored.map((entry) =>
        entry.versionId === versionId ? { ...entry, fileName } : entry,
      ),
    );
    // updateIndex swallows a failed write, and the old copy may only go once
    // the index points at the new one.
    if (
      records.find((entry) => entry.versionId === versionId)?.fileName !==
      fileName
    )
      throw new Error("Couldn't record where the download moved.");
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
        {
          ...input,
          subtitles,
          written: 0,
          state: "queued",
          etag: null,
          fileName: null,
        },
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
      // Downloads land in browser storage, where they resume in place, and
      // a finished one goes on to the linked folder.
      if (record.state === "complete" && !entry.remove && !entry.skipped)
        await move(record.versionId, "folder").catch(() => {});
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
        await saveArtwork(record, entry.controller.signal);
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
    if (index < 0 || moving.has(versionId)) return;
    const fileName = records[index]?.fileName ?? null;
    const place = fileName === null ? await directory() : await deps.folder?.();
    if (place === undefined)
      throw new Error("The download folder needs access.");
    const [removed] = records.splice(index, 1);
    try {
      await place.removeEntry(fileName ?? versionId);
    } catch {}
    for (const track of removed?.subtitles ?? []) {
      try {
        await (await directory()).removeEntry(track.name);
      } catch {}
    }
    notify();
    // Under the index lock, so a sibling Episode starting in another tab
    // either keeps the shared artwork or saves it again after.
    await updateIndex(
      (stored) => stored.filter((entry) => entry.versionId !== versionId),
      async (remaining) => {
        if (removed !== undefined) await dropArtwork(removed, remaining);
      },
    );
    await refreshEstimate();
    notify();
  }

  return {
    subscribe: store.subscribe,
    restore,
    start,
    pause,
    resume,
    remove,
    move,
    adopt,
    release,
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
