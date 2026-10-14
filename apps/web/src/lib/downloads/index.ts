import {
  createDownloads,
  type DownloadRecord,
  type Downloads,
} from "./store.ts";

export {
  type DownloadRecord,
  type DownloadState,
  type DownloadStream,
  type Downloads,
  type DownloadsSnapshot,
  downloadsSupported,
} from "./store.ts";

let instance: Downloads | undefined;

// Created lazily so importing this during SSR or in a browser without OPFS
// never touches navigator.
function downloads_(): Downloads {
  if (instance === undefined)
    instance = createDownloads({
      root: () => navigator.storage.getDirectory(),
      fetch: ((input, init) => fetch(input, init)) as typeof fetch,
      storage: navigator.storage,
    });
  return instance;
}

/** The browser's download queue. */
export const downloads: Downloads = {
  subscribe: (...args) => downloads_().subscribe(...args),
  restore: () => downloads_().restore(),
  start: (input: Omit<DownloadRecord, "written" | "state">) =>
    downloads_().start(input),
  pause: (versionId) => downloads_().pause(versionId),
  resume: (versionId) => downloads_().resume(versionId),
  remove: (versionId) => downloads_().remove(versionId),
};
