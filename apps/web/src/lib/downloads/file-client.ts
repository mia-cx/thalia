import type { DownloadFile } from "./store.ts";

/** File operations sent to the dedicated OPFS worker. */
export type FileRequest = { id: number; versionId: string } & (
  | { operation: "open" | "size" | "flush" | "close" }
  | { operation: "truncate"; size: number }
  | { operation: "write"; bytes: Uint8Array<ArrayBuffer>; at: number }
);
/** A worker response, correlated with its request id. */
export type FileReply =
  | { id: number; result?: number }
  | { id: number; error: { name: string; message: string } };

/** Connects one shared dedicated worker to the store's asynchronous file seam. */
export function downloadFiles(worker: Worker) {
  let nextId = 0;
  let failure: Error | undefined;
  const pending = new Map<
    number,
    { resolve(value: number | undefined): void; reject(error: Error): void }
  >();
  worker.addEventListener("message", (event: MessageEvent<FileReply>) => {
    const reply = event.data;
    const request = pending.get(reply.id);
    pending.delete(reply.id);
    if ("error" in reply)
      request?.reject(new DOMException(reply.error.message, reply.error.name));
    else request?.resolve(reply.result);
  });
  function fail(error: Error) {
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }
  worker.addEventListener("error", (event) => fail(new Error(event.message)));
  worker.addEventListener("messageerror", () =>
    fail(new Error("Download worker message could not be read.")),
  );
  function send(request: FileRequest): Promise<number | undefined> {
    if (failure !== undefined) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      pending.set(request.id, { resolve, reject });
      try {
        worker.postMessage(
          request,
          request.operation === "write" ? [request.bytes.buffer] : [],
        );
      } catch (error) {
        pending.delete(request.id);
        reject(error);
      }
    });
  }
  return async (versionId: string): Promise<DownloadFile> => {
    const call = (operation: "open" | "size" | "flush" | "close") =>
      send({ id: ++nextId, versionId, operation });
    await call("open");
    return {
      size: async () => (await call("size")) as number,
      write: async (chunk, at) => {
        // Transfer an owned buffer; a subarray may share its backing bytes.
        const bytes =
          chunk.buffer instanceof ArrayBuffer &&
          chunk.byteOffset === 0 &&
          chunk.byteLength === chunk.buffer.byteLength
            ? (chunk as Uint8Array<ArrayBuffer>)
            : new Uint8Array(chunk);
        await send({ id: ++nextId, versionId, operation: "write", bytes, at });
      },
      flush: async () => {
        await call("flush");
      },
      truncate: async (size) => {
        await send({ id: ++nextId, versionId, operation: "truncate", size });
      },
      close: async () => {
        await call("close");
      },
    };
  };
}
