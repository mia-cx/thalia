import type { DownloadRecord } from "./store.ts";

// A folder on disk the user links for downloads, on Chromium desktop
// browsers. Its files carry readable names, and `.thalia/downloads.json`
// lists them, so the folder still describes itself in a later session.

/** Whether this browser can link a folder on disk. */
export function folderSupported(): boolean {
  return typeof globalThis.showDirectoryPicker === "function";
}

const unsafeName = /[\\/:*?"<>|\p{Cc}]+/gu;
const extensions: Record<string, string> = { mpegts: "ts" };

/** A readable file name for a download, such as `Arrival (2016).mkv`. */
export function fileNameFor(
  record: Pick<DownloadRecord, "title" | "container" | "versionId">,
): string {
  const base =
    record.title
      .replace(unsafeName, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/, "") || record.versionId;
  const container = record.container;
  return container === null
    ? base
    : `${base}.${extensions[container] ?? container}`;
}

async function exists(
  folder: FileSystemDirectoryHandle,
  name: string,
): Promise<boolean> {
  try {
    await folder.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

function splitName(name: string): [stem: string, extension: string] {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

/**
 * A download's file as the folder names it: the media is `fileName`, and a
 * saved subtitle (`<versionId>.en.srt`) sits beside it as `Arrival (2016).en.srt`,
 * where media players find it.
 */
export function folderName(
  versionId: string,
  fileName: string,
  name: string,
): string {
  if (name === versionId) return fileName;
  return `${splitName(fileName)[0]}${name.slice(versionId.length)}`;
}

/**
 * `name`, or `name (2)` and on, whichever the folder holds neither under
 * nor with any of `sidecars` beside, such as `.en.srt`.
 */
export async function freeName(
  folder: FileSystemDirectoryHandle,
  name: string,
  sidecars: readonly string[] = [],
): Promise<string> {
  const [stem, extension] = splitName(name);
  for (let n = 1; ; n++) {
    const base = n === 1 ? stem : `${stem} (${n})`;
    const taken = await Promise.all(
      [extension, ...sidecars].map((suffix) =>
        exists(folder, `${base}${suffix}`),
      ),
    );
    if (!taken.includes(true)) return `${base}${extension}`;
  }
}

/**
 * Streams `source` into `name` in `folder` and checks every byte landed. A
 * writable commits only when it closes, so a failed copy leaves nothing.
 */
export async function copyInto(
  source: File,
  folder: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  const handle = await folder.getFileHandle(name, { create: true });
  let writable: FileSystemWritableFileStream | undefined;
  try {
    writable = await handle.createWritable();
    const reader = source.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
    }
    await writable.close();
    writable = undefined;
    if ((await handle.getFile()).size !== source.size)
      throw new Error(`Copying ${name} lost bytes.`);
  } catch (error) {
    await writable?.abort().catch(() => {});
    await folder.removeEntry(name).catch(() => {});
    throw error;
  }
}

const manifestFolder = ".thalia";
const manifestName = "downloads.json";

/** The downloads a folder's manifest lists; none when it has no manifest. */
export async function readManifest(
  folder: FileSystemDirectoryHandle,
): Promise<unknown[]> {
  try {
    const dir = await folder.getDirectoryHandle(manifestFolder);
    const file = await (await dir.getFileHandle(manifestName)).getFile();
    const parsed: unknown = JSON.parse(await file.text());
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Replaces the folder's manifest with `records`. */
export async function writeManifest(
  folder: FileSystemDirectoryHandle,
  records: DownloadRecord[],
): Promise<void> {
  const dir = await folder.getDirectoryHandle(manifestFolder, {
    create: true,
  });
  const writable = await (
    await dir.getFileHandle(manifestName, { create: true })
  ).createWritable();
  await writable.write(JSON.stringify(records));
  await writable.close();
}

// The linked folder's handle outlives the session in IndexedDB, the only
// storage that keeps a handle.
const database = "thalia";
const handles = "handles";
const folderKey = "downloads-folder";

function request<T>(
  run: (store: IDBObjectStore) => IDBRequest<T>,
  mode: IDBTransactionMode,
) {
  return new Promise<T>((resolve, reject) => {
    const open = indexedDB.open(database, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(handles);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const call = run(db.transaction(handles, mode).objectStore(handles));
      call.onsuccess = () => {
        resolve(call.result);
        db.close();
      };
      call.onerror = () => {
        reject(call.error);
        db.close();
      };
    };
  });
}

/** The linked folder's handle, if one was linked. */
export async function loadFolder(): Promise<
  FileSystemDirectoryHandle | undefined
> {
  const found = await request((store) => store.get(folderKey), "readonly");
  return found instanceof FileSystemDirectoryHandle ? found : undefined;
}

/** Keeps `folder` as the linked folder across sessions. */
export async function saveFolder(
  folder: FileSystemDirectoryHandle,
): Promise<void> {
  await request((store) => store.put(folder, folderKey), "readwrite");
}

/** Forgets the linked folder; its files stay on disk. */
export async function forgetFolder(): Promise<void> {
  await request((store) => store.delete(folderKey), "readwrite");
}
