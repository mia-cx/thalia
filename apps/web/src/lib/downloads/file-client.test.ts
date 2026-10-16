import { expect, test } from "bun:test";
import {
  downloadFiles,
  type FileReply,
  type FileRequest,
} from "./file-client.ts";

class FakeWorker extends EventTarget {
  requests: FileRequest[] = [];
  error: FileReply | undefined;
  postMessage(request: FileRequest, transfer: Transferable[]) {
    this.requests.push(structuredClone(request, { transfer }));
    queueMicrotask(() =>
      this.dispatchEvent(
        new MessageEvent("message", {
          data: this.error ?? {
            id: request.id,
            result: request.operation === "size" ? 42 : undefined,
          },
        }),
      ),
    );
  }
}

test("file messages transfer owned buffers and copy subarrays", async () => {
  const worker = new FakeWorker();
  const file = await downloadFiles(worker as unknown as Worker)("version");
  expect(await file.size()).toBe(42);
  const owned = new Uint8Array([1, 2, 3]);
  await file.write(owned, 0);
  expect(owned.byteLength).toBe(0);
  const shared = new Uint8Array([4, 5, 6, 7]);
  await file.write(shared.subarray(1, 3), 3);
  expect(shared).toEqual(new Uint8Array([4, 5, 6, 7]));
  expect(worker.requests.filter((r) => r.operation === "write")).toMatchObject([
    { at: 0, bytes: new Uint8Array([1, 2, 3]) },
    { at: 3, bytes: new Uint8Array([5, 6]) },
  ]);
  await file.close();
});

test("an exclusive handle error rejects open", async () => {
  const worker = new FakeWorker();
  worker.error = {
    id: 1,
    error: { name: "NoModificationAllowedError", message: "File is held." },
  };
  await expect(
    downloadFiles(worker as unknown as Worker)("version"),
  ).rejects.toMatchObject({ name: "NoModificationAllowedError" });
});

test("a broken worker rejects pending and future requests", async () => {
  const worker = new FakeWorker();
  const file = await downloadFiles(worker as unknown as Worker)("version");
  const pending = file.flush();
  worker.dispatchEvent(new Event("messageerror"));
  await expect(pending).rejects.toThrow("could not be read");
  await expect(file.close()).rejects.toThrow("could not be read");
});
