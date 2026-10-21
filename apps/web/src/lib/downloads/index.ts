import { get, type Readable, writable } from "svelte/store";
import type { ItemDetail } from "../browse.ts";
import { downloadFiles } from "./file-client.ts";
import {
  folderSupported,
  forgetFolder,
  loadFolder,
  saveFolder,
} from "./folder.ts";
import { downloadedDetail } from "./library.ts";
import {
  createDownloads,
  type DownloadInput,
  type Downloads,
  downloadsSupported,
} from "./store.ts";

export { folderSupported } from "./folder.ts";
export {
  type DownloadedItem,
  type DownloadedShow,
  groupDownloads,
} from "./library.ts";
export {
  type DownloadInput,
  type DownloadRecord,
  type DownloadState,
  type DownloadStream,
  type Downloads,
  type DownloadsSnapshot,
  downloadsSupported,
} from "./store.ts";

/** The linked folder as the Downloads page shows it: its name, and whether the browser grants access now. */
export type FolderSnapshot = { name: string; access: PermissionState };

let handle: FileSystemDirectoryHandle | undefined;
let loaded: Promise<void> | undefined;
const folderState = writable<FolderSnapshot | undefined>(undefined);

const readwrite = { mode: "readwrite" } as const;

async function publishFolder(): Promise<void> {
  folderState.set(
    handle === undefined
      ? undefined
      : { name: handle.name, access: await handle.queryPermission(readwrite) },
  );
}

/** Reads the linked folder back once per page, where the browser can link one. */
function loadLinked(): Promise<void> {
  loaded ??= folderSupported()
    ? loadFolder()
        .then((found) => {
          handle = found;
        })
        .catch(() => {})
        .then(publishFolder)
    : Promise.resolve();
  return loaded;
}

async function grantedFolder(): Promise<FileSystemDirectoryHandle | undefined> {
  await loadLinked();
  if (handle === undefined) return undefined;
  return (await handle.queryPermission(readwrite)) === "granted"
    ? handle
    : undefined;
}

let instance: Downloads | undefined;

// Created lazily so importing this during SSR or in a browser without OPFS
// never touches navigator.
function downloads_(): Downloads {
  if (instance === undefined)
    instance = createDownloads({
      root: () => navigator.storage.getDirectory(),
      open: downloadFiles(
        new Worker(new URL("./file-worker.ts", import.meta.url), {
          type: "module",
        }),
      ),
      fetch: ((input, init) => fetch(input, init)) as typeof fetch,
      storage: navigator.storage,
      locks: "locks" in navigator ? navigator.locks : undefined,
      channel:
        typeof BroadcastChannel === "undefined"
          ? undefined
          : new BroadcastChannel("thalia-downloads"),
      folder: grantedFolder,
    });
  return instance;
}

/** The saved detail of this browser's finished download of `itemId`, for its page to open offline. */
export async function offlineDetail(
  itemId: string,
): Promise<ItemDetail | undefined> {
  if (!downloadsSupported()) return undefined;
  await downloads.restore();
  return downloadedDetail(get(downloads).records, itemId);
}

/** The browser's download queue. */
export const downloads: Downloads = {
  subscribe: (...args) => downloads_().subscribe(...args),
  restore: () => downloads_().restore(),
  start: (input: DownloadInput) => downloads_().start(input),
  pause: (versionId) => downloads_().pause(versionId),
  resume: (versionId) => downloads_().resume(versionId),
  remove: (versionId) => downloads_().remove(versionId),
  move: (versionId, to) => downloads_().move(versionId, to),
  adopt: () => downloads_().adopt(),
  release: () => downloads_().release(),
  file: (name) => downloads_().file(name),
};

/**
 * The folder on disk downloads go to, on browsers that can link one. New
 * downloads move there once finished, and the folder's earlier downloads
 * join the list once the browser grants access.
 */
export const downloadFolder: Readable<FolderSnapshot | undefined> & {
  restore(): Promise<void>;
  /** Asks the user for a folder and links it; needs a user gesture. */
  link(): Promise<void>;
  /** Asks the browser for access to the linked folder again; needs a user gesture. */
  allow(): Promise<void>;
  /** Unlinks the folder; its files stay on disk for a later link. */
  unlink(): Promise<void>;
} = {
  subscribe: folderState.subscribe,
  restore: loadLinked,
  async link() {
    const picked = await globalThis.showDirectoryPicker?.({
      id: "thalia-downloads",
      mode: "readwrite",
    });
    if (picked === undefined) return;
    await loadLinked();
    if (handle !== undefined && !(await handle.isSameEntry(picked))) {
      // The old folder keeps its files and manifest; its rows leave the list.
      handle = undefined;
      await downloads.release();
    }
    await saveFolder(picked);
    handle = picked;
    await publishFolder();
    await downloads.adopt();
  },
  async allow() {
    await loadLinked();
    await handle?.requestPermission(readwrite);
    await publishFolder();
    await downloads.adopt();
  },
  async unlink() {
    await forgetFolder();
    handle = undefined;
    await publishFolder();
    await downloads.release();
  },
};
