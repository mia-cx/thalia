/// <reference lib="webworker" />

import type { FileReply, FileRequest } from "./file-client.ts";

const worker = self as unknown as DedicatedWorkerGlobalScope;
const handles = new Map<string, FileSystemSyncAccessHandle>();

worker.addEventListener("message", async (event: MessageEvent<FileRequest>) => {
  const request = event.data;
  try {
    let result: number | undefined;
    if (request.operation === "open") {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("downloads", { create: true });
      const file = await dir.getFileHandle(request.versionId, { create: true });
      handles.set(request.versionId, await file.createSyncAccessHandle());
    } else {
      const handle = handles.get(request.versionId);
      if (handle === undefined) throw new Error("Download file is not open.");
      switch (request.operation) {
        case "size":
          result = handle.getSize();
          break;
        case "write": {
          let written = 0;
          while (written < request.bytes.byteLength) {
            const count = handle.write(request.bytes.subarray(written), {
              at: request.at + written,
            });
            if (count === 0)
              throw new Error("Download write made no progress.");
            written += count;
          }
          break;
        }
        case "flush":
          handle.flush();
          break;
        case "truncate":
          handle.truncate(request.size);
          break;
        case "close":
          handle.close();
          handles.delete(request.versionId);
          break;
      }
    }
    worker.postMessage({ id: request.id, result } satisfies FileReply);
  } catch (error) {
    worker.postMessage({
      id: request.id,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      },
    } satisfies FileReply);
  }
});
