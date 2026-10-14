import { describe, expect, test } from "bun:test";
import { get } from "svelte/store";
import { createDownloads } from "./store.ts";

// An in-memory OPFS stand-in at the FileSystemDirectoryHandle boundary:
// writables stage bytes that swap into the file only on close().
class FakeFile {
  constructor(private readonly data: Uint8Array) {}
  get size() {
    return this.data.length;
  }
  async arrayBuffer() {
    return this.data.slice().buffer;
  }
  async text() {
    return new TextDecoder().decode(this.data);
  }
}

class FakeWritable {
  private buffer: Uint8Array;
  private position = 0;
  closed = false;
  constructor(
    private readonly handle: FakeFileHandle,
    existing: Uint8Array | undefined,
  ) {
    this.buffer = existing ?? new Uint8Array(0);
  }
  async seek(position: number) {
    this.position = position;
  }
  async truncate(size: number) {
    this.buffer = this.buffer.slice(0, size);
    if (this.position > size) this.position = size;
  }
  async write(data: Uint8Array | string | Blob) {
    const chunk =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : data instanceof Blob
          ? new Uint8Array(await data.arrayBuffer())
          : data;
    const end = this.position + chunk.byteLength;
    if (end > this.buffer.length) {
      const grown = new Uint8Array(end);
      grown.set(this.buffer);
      this.buffer = grown;
    }
    this.buffer.set(chunk, this.position);
    this.position = end;
  }
  async close() {
    this.closed = true;
    this.handle.commit(this.buffer);
  }
}

class FakeFileHandle {
  constructor(
    private readonly dir: FakeDir,
    private readonly name: string,
  ) {}
  async getFile() {
    const data = this.dir.files.get(this.name);
    if (data === undefined)
      throw new DOMException("Not found.", "NotFoundError");
    return new FakeFile(data);
  }
  async createWritable(options?: { keepExistingData?: boolean }) {
    const existing = this.dir.files.get(this.name);
    return new FakeWritable(
      this,
      options?.keepExistingData === true ? existing?.slice() : undefined,
    );
  }
  commit(data: Uint8Array) {
    this.dir.files.set(this.name, data);
  }
}

class FakeDir {
  readonly dirs = new Map<string, FakeDir>();
  readonly files = new Map<string, Uint8Array>();
  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    let dir = this.dirs.get(name);
    if (dir === undefined) {
      if (options?.create !== true)
        throw new DOMException("Not found.", "NotFoundError");
      dir = new FakeDir();
      this.dirs.set(name, dir);
    }
    return dir;
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!this.files.has(name)) {
      if (options?.create !== true)
        throw new DOMException("Not found.", "NotFoundError");
      this.files.set(name, new Uint8Array(0));
    }
    return new FakeFileHandle(this, name);
  }
  async removeEntry(name: string) {
    if (this.dirs.delete(name) || this.files.delete(name)) return;
    throw new DOMException("Not found.", "NotFoundError");
  }
}

type FetchCall = {
  url: string;
  range: string | undefined;
  ifRange: string | undefined;
};

/** Serves `bytes` honouring `Range: bytes=N-` and `If-Range`, chunked through a ReadableStream; gates pause before chunk i. */
function fakeFetch(
  bytes: Uint8Array,
  options: {
    chunk?: number;
    gates?: (Promise<void> | undefined)[];
    ignoreRange?: boolean;
    etag?: string;
  } = {},
) {
  const calls: FetchCall[] = [];
  const transport = async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url, range: headers.range, ifRange: headers["if-range"] });
    const out = new Headers();
    let offset = 0;
    let status = 200;
    const staleIfRange =
      headers["if-range"] !== undefined && headers["if-range"] !== options.etag;
    const match = /^bytes=(\d+)-$/.exec(headers.range ?? "");
    if (match && options.ignoreRange !== true && !staleIfRange) {
      offset = Number(match[1]);
      status = 206;
    }
    if (options.etag !== undefined) out.set("etag", options.etag);
    const body = bytes.subarray(offset);
    out.set("content-length", String(body.length));
    if (status === 206)
      out.set(
        "content-range",
        `bytes ${offset}-${bytes.length - 1}/${bytes.length}`,
      );
    const chunk = options.chunk ?? Math.max(1, body.length);
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        init.signal?.addEventListener("abort", () =>
          controller.error(new DOMException("Aborted.", "AbortError")),
        );
        try {
          for (let i = 0; i < body.length; i += chunk, index++) {
            await options.gates?.[index];
            controller.enqueue(body.subarray(i, i + chunk));
          }
          controller.close();
        } catch {}
      },
    });
    return new Response(stream, { status, headers: out });
  };
  return { transport: transport as unknown as typeof fetch, calls };
}

function fakeStorage(
  options: { persist?: boolean; persisted?: boolean; quota?: number } = {},
) {
  const calls = { persist: 0 };
  const storage = {
    persist: async () => {
      calls.persist += 1;
      return options.persist ?? true;
    },
    persisted: async () => options.persisted ?? false,
    estimate: async () => ({ usage: 100, quota: options.quota ?? 1000 }),
  };
  return { storage, calls };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for the store.");
}

const bytes = Uint8Array.from({ length: 64 }, (_, i) => i);

const input = {
  itemId: "01900000-0000-7000-8000-000000000001",
  versionId: "01900000-0000-7000-8000-000000000002",
  title: "Movie (2026)",
  bytes: bytes.length,
  container: "mp4",
  streams: [],
};

function makeStore(
  root: FakeDir,
  transport: typeof fetch,
  storage: ReturnType<typeof fakeStorage>["storage"],
) {
  return createDownloads({
    root: async () => root as unknown as FileSystemDirectoryHandle,
    fetch: transport,
    storage,
    commitBytes: 16,
  });
}

function fileOf(root: FakeDir) {
  return root.dirs.get("downloads")?.files.get(input.versionId);
}

/** Writes an index.json and partial file into a fake root, as a reload would find them. */
async function seedIndex(root: FakeDir, records: unknown[], file?: Uint8Array) {
  const dir = await root.getDirectoryHandle("downloads", { create: true });
  dir.files.set(
    "index.json",
    new TextEncoder().encode(JSON.stringify(records)),
  );
  if (file !== undefined) dir.files.set(input.versionId, file);
}

describe("downloads store", () => {
  test("streams a file into OPFS and marks it complete", async () => {
    const root = new FakeDir();
    const { transport, calls } = fakeFetch(bytes, { chunk: 8 });
    const { storage, calls: persisted } = fakeStorage();
    const store = makeStore(root, transport, storage);
    await store.start(input);
    await waitFor(() => get(store).records[0]?.state === "complete");
    expect(fileOf(root)).toEqual(bytes);
    const snapshot = get(store);
    expect(snapshot.records[0]?.written).toBe(64);
    expect(snapshot.persisted).toBe(true);
    expect(persisted.persist).toBe(1);
    expect(snapshot.storage).toEqual({
      usage: 100,
      quota: 1000,
      downloads: 64,
    });
    expect(calls).toEqual([
      {
        url: `/api/items/${input.itemId}/versions/${input.versionId}/download`,
        range: undefined,
        ifRange: undefined,
      },
    ]);
  });

  test("pause commits and resume continues with a Range header", async () => {
    const root = new FakeDir();
    const gate = deferred();
    const { transport, calls } = fakeFetch(bytes, {
      chunk: 8,
      gates: [undefined, undefined, gate.promise],
    });
    const { storage } = fakeStorage();
    const store = makeStore(root, transport, storage);
    await store.start(input);
    // Two chunks committed (8 + 8 = 16 bytes), the third is still gated.
    await waitFor(() => fileOf(root)?.length === 16);
    const pausing = store.pause(input.versionId);
    gate.resolve();
    await pausing;
    expect(get(store).records[0]?.state).toBe("paused");
    expect(get(store).records[0]?.written).toBe(16);
    expect(fileOf(root)?.length).toBe(16);

    await store.resume(input.versionId);
    await waitFor(() => get(store).records[0]?.state === "complete");
    expect(calls[1]?.range).toBe("bytes=16-");
    expect(fileOf(root)).toEqual(bytes);
  });

  test("a 200 answer to a Range request restarts the file", async () => {
    const root = new FakeDir();
    const gate = deferred();
    const first = fakeFetch(bytes, {
      chunk: 8,
      gates: [undefined, gate.promise],
    });
    const { storage } = fakeStorage();
    const store = makeStore(root, first.transport, storage);
    await store.start(input);
    await waitFor(() => (get(store).records[0]?.written ?? 0) >= 8);
    const pausing = store.pause(input.versionId);
    gate.resolve();
    await pausing;
    expect(fileOf(root)?.length).toBe(8);

    // The resumed request ignores the Range and answers 200: restart whole.
    const second = fakeFetch(bytes, { chunk: 8, ignoreRange: true });
    const restarted = createDownloads({
      root: async () => root as unknown as FileSystemDirectoryHandle,
      fetch: ((input, init) => second.transport(input, init)) as typeof fetch,
      storage,
      commitBytes: 16,
    });
    // Share the same store's records is impossible; resume through a fresh
    // transfer by calling resume on a store that restored the index.
    await restarted.restore();
    await restarted.resume(input.versionId);
    await waitFor(() => get(restarted).records[0]?.state === "complete");
    expect(second.calls[0]?.range).toBe("bytes=8-");
    expect(fileOf(root)).toEqual(bytes);
  });

  test("remove deletes the file and record, paused or complete", async () => {
    const root = new FakeDir();
    const gate = deferred();
    const { transport } = fakeFetch(bytes, {
      chunk: 8,
      gates: [undefined, gate.promise],
    });
    const { storage } = fakeStorage();
    const store = makeStore(root, transport, storage);
    await store.start(input);
    await waitFor(() => (get(store).records[0]?.written ?? 0) >= 8);
    const pausing = store.pause(input.versionId);
    gate.resolve();
    await pausing;
    await store.remove(input.versionId);
    expect(get(store).records).toEqual([]);
    expect(fileOf(root)).toBeUndefined();
    expect(get(store).storage?.downloads).toBe(0);

    const again = fakeFetch(bytes);
    const complete = createDownloads({
      root: async () => root as unknown as FileSystemDirectoryHandle,
      fetch: ((input, init) => again.transport(input, init)) as typeof fetch,
      storage,
      commitBytes: 16,
    });
    await complete.restore();
    await complete.start(input);
    await waitFor(() => get(complete).records[0]?.state === "complete");
    await complete.remove(input.versionId);
    expect(get(complete).records).toEqual([]);
    expect(fileOf(root)).toBeUndefined();
    expect(get(complete).storage?.downloads).toBe(0);
  });

  test("restore picks a mid-download record up as paused and resume finishes it", async () => {
    const root = new FakeDir();
    const gate = deferred();
    const first = fakeFetch(bytes, {
      chunk: 8,
      gates: [undefined, undefined, gate.promise],
    });
    const { storage } = fakeStorage();
    const store = makeStore(root, first.transport, storage);
    await store.start(input);
    await waitFor(() => fileOf(root)?.length === 16);
    const pausing = store.pause(input.versionId);
    gate.resolve();
    await pausing;

    // A reload: a new store over the same root reads the index back.
    const resumed = fakeFetch(bytes, { chunk: 8 });
    const restored = createDownloads({
      root: async () => root as unknown as FileSystemDirectoryHandle,
      fetch: ((input, init) => resumed.transport(input, init)) as typeof fetch,
      storage,
      commitBytes: 16,
    });
    await restored.restore();
    const snapshot = get(restored);
    expect(snapshot.ready).toBe(true);
    expect(snapshot.records).toEqual([
      { ...input, written: 16, state: "paused", etag: null },
    ]);
    await restored.resume(input.versionId);
    await waitFor(() => get(restored).records[0]?.state === "complete");
    expect(resumed.calls[0]?.range).toBe("bytes=16-");
    expect(fileOf(root)).toEqual(bytes);
  });

  test("a refused persist still completes and is asked once across starts", async () => {
    const root = new FakeDir();
    const { transport } = fakeFetch(bytes, { chunk: 8 });
    const { storage, calls } = fakeStorage({ persist: false });
    const store = makeStore(root, transport, storage);
    const other = {
      ...input,
      versionId: "01900000-0000-7000-8000-000000000003",
    };
    await store.start(input);
    await store.start(other);
    expect(calls.persist).toBe(1);
    expect(get(store).persisted).toBe(false);
    await waitFor(
      () =>
        get(store).records.every((record) => record.state === "complete") &&
        get(store).records.length === 2,
    );
    expect(fileOf(root)).toEqual(bytes);
    expect(root.dirs.get("downloads")?.files.get(other.versionId)).toEqual(
      bytes,
    );
    expect(calls.persist).toBe(1);
  });

  test("after a restore, start asks persist() once and keeps its answer", async () => {
    const root = new FakeDir();
    const { transport } = fakeFetch(bytes, { chunk: 8 });
    const { storage, calls } = fakeStorage({
      persisted: false,
      persist: true,
    });
    const store = makeStore(root, transport, storage);
    await store.restore();
    expect(get(store).persisted).toBe(false);
    expect(calls.persist).toBe(0);
    await store.start(input);
    expect(calls.persist).toBe(1);
    expect(get(store).persisted).toBe(true);
    await store.start({
      ...input,
      versionId: "01900000-0000-7000-8000-000000000004",
    });
    expect(calls.persist).toBe(1);
  });

  test("start after a restore cannot duplicate a record", async () => {
    const root = new FakeDir();
    await seedIndex(
      root,
      [{ ...input, written: 8, state: "paused" }],
      bytes.subarray(0, 8),
    );
    const { transport } = fakeFetch(bytes, { chunk: 8 });
    const { storage } = fakeStorage();
    const store = makeStore(root, transport, storage);
    await store.start(input);
    expect(get(store).records).toHaveLength(1);
    expect(get(store).records[0]?.state).not.toBe("queued");
  });

  test("a 416 at the file's size completes; anywhere else it fails", async () => {
    const root = new FakeDir();
    await seedIndex(root, [{ ...input, written: 64, state: "paused" }], bytes);
    const answer416 = async () => new Response(null, { status: 416 });
    const { storage } = fakeStorage();
    const done = createDownloads({
      root: async () => root as unknown as FileSystemDirectoryHandle,
      fetch: answer416 as unknown as typeof fetch,
      storage,
      commitBytes: 16,
    });
    await done.resume(input.versionId);
    await waitFor(() => get(done).records[0]?.state === "complete");
    expect(fileOf(root)).toEqual(bytes);

    const short = new FakeDir();
    await seedIndex(
      short,
      [{ ...input, written: 32, state: "paused" }],
      bytes.subarray(0, 32),
    );
    const broken = createDownloads({
      root: async () => short as unknown as FileSystemDirectoryHandle,
      fetch: answer416 as unknown as typeof fetch,
      storage,
      commitBytes: 16,
    });
    await broken.resume(input.versionId);
    await waitFor(() => get(broken).records[0]?.state === "failed");
  });

  test("a root that throws marks the store unavailable", async () => {
    const { storage } = fakeStorage();
    const store = createDownloads({
      root: async () => {
        throw new DOMException("OPFS denied.", "SecurityError");
      },
      fetch: fakeFetch(bytes).transport,
      storage,
      commitBytes: 16,
    });
    await store.restore();
    const snapshot = get(store);
    expect(snapshot.unavailable).toBe(true);
    expect(snapshot.ready).toBe(true);
    expect(snapshot.records).toEqual([]);
  });

  test("a malformed index restores only the valid record", async () => {
    const root = new FakeDir();
    await seedIndex(
      root,
      [null, 42, { ...input, written: 8, state: "paused" }],
      bytes.subarray(0, 8),
    );
    const { storage } = fakeStorage();
    const store = makeStore(root, fakeFetch(bytes).transport, storage);
    await store.restore();
    const snapshot = get(store);
    expect(snapshot.ready).toBe(true);
    expect(snapshot.records).toEqual([
      { ...input, written: 8, state: "paused", etag: null },
    ]);
  });

  test("two overlapping first starts of one Version queue one record", async () => {
    const root = new FakeDir();
    const gate = deferred();
    const { transport, calls } = fakeFetch(bytes, { chunk: 8 });
    const storage = {
      persist: () => gate.promise.then(() => true),
      persisted: async () => false,
      estimate: async () => ({ usage: 100, quota: 1000 }),
    };
    const store = makeStore(root, transport, storage);
    const first = store.start(input);
    const second = store.start(input);
    gate.resolve();
    await Promise.all([first, second]);
    await waitFor(() => get(store).records[0]?.state === "complete");
    expect(get(store).records).toHaveLength(1);
    expect(fileOf(root)).toEqual(bytes);
    expect(calls).toHaveLength(1);
  });

  test("resume sends If-Range and restarts when the source changed", async () => {
    const root = new FakeDir();
    const gate = deferred();
    const first = fakeFetch(bytes, {
      chunk: 8,
      gates: [undefined, undefined, gate.promise],
      etag: "tag-one",
    });
    const { storage } = fakeStorage();
    const store = makeStore(root, first.transport, storage);
    await store.start(input);
    await waitFor(() => fileOf(root)?.length === 16);
    const pausing = store.pause(input.versionId);
    gate.resolve();
    await pausing;

    // The library replaced the file in place under the same ids.
    const changed = Uint8Array.from({ length: 64 }, (_, i) => 64 + i);
    const second = fakeFetch(changed, { chunk: 8, etag: "tag-two" });
    const resumed = createDownloads({
      root: async () => root as unknown as FileSystemDirectoryHandle,
      fetch: ((input, init) => second.transport(input, init)) as typeof fetch,
      storage,
      commitBytes: 16,
    });
    await resumed.restore();
    expect(get(resumed).records[0]?.etag).toBe("tag-one");
    await resumed.resume(input.versionId);
    await waitFor(() => get(resumed).records[0]?.state === "complete");
    expect(second.calls[0]?.ifRange).toBe("tag-one");
    expect(second.calls[0]?.range).toBe("bytes=16-");
    expect(fileOf(root)).toEqual(changed);
  });
});

// In-memory stand-ins for Web Locks and BroadcastChannel so two stores act
// like two tabs over one shared OPFS root.
class FakeLocks {
  private tails = new Map<string, Promise<unknown>>();
  private held = new Set<string>();
  request(
    name: string,
    options: { ifAvailable?: boolean } | ((lock: object | null) => unknown),
    callback?: (lock: object | null) => Promise<unknown>,
  ) {
    const run = (typeof options === "function" ? options : callback) as (
      lock: object | null,
    ) => Promise<unknown>;
    const ifAvailable =
      typeof options === "object" && options.ifAvailable === true;
    if (ifAvailable && this.held.has(name)) return Promise.resolve(run(null));
    const previous = this.tails.get(name) ?? Promise.resolve();
    const next = previous.then(async () => {
      this.held.add(name);
      try {
        return await run({});
      } finally {
        this.held.delete(name);
      }
    });
    this.tails.set(
      name,
      next.catch(() => {}),
    );
    return next;
  }
}

function channelPair() {
  const listenersA: ((event: { data: unknown }) => void)[] = [];
  const listenersB: ((event: { data: unknown }) => void)[] = [];
  const make = (
    own: typeof listenersA,
    other: typeof listenersA,
  ): Pick<BroadcastChannel, "postMessage" | "addEventListener"> => ({
    postMessage(data: unknown) {
      for (const listener of other) listener({ data });
    },
    addEventListener(_type: string, listener: EventListener) {
      own.push(listener as unknown as (event: { data: unknown }) => void);
    },
  });
  return [make(listenersA, listenersB), make(listenersB, listenersA)] as const;
}

describe("downloads across tabs", () => {
  const otherBytes = Uint8Array.from({ length: 64 }, (_, i) => 200 - i);
  const otherInput = {
    ...input,
    versionId: "01900000-0000-7000-8000-000000000005",
  };

  function tabStore(
    root: FakeDir,
    transport: typeof fetch,
    locks: FakeLocks,
    channel: Pick<BroadcastChannel, "postMessage" | "addEventListener">,
    storage = fakeStorage().storage,
  ) {
    return createDownloads({
      root: async () => root as unknown as FileSystemDirectoryHandle,
      fetch: transport,
      storage,
      locks: locks as unknown as Pick<LockManager, "request">,
      channel,
      commitBytes: 16,
    });
  }

  test("two tabs download different Versions into one index", async () => {
    const root = new FakeDir();
    const locks = new FakeLocks();
    const [channelA, channelB] = channelPair();
    const first = fakeFetch(bytes, { chunk: 8 });
    const second = fakeFetch(otherBytes, { chunk: 8 });
    const a = tabStore(root, first.transport, locks, channelA);
    const b = tabStore(root, second.transport, locks, channelB);
    await a.restore();
    await b.restore();
    await a.start(input);
    await waitFor(() => get(a).records[0]?.state === "complete");
    await b.start(otherInput);
    await waitFor(
      () =>
        get(b).records.some((r) => r.state === "complete") &&
        get(b).records.length === 2,
    );
    await waitFor(() => get(a).records.length === 2);
    expect(get(b).records).toHaveLength(2);

    // A third tab restoring from the root lists both.
    const c = tabStore(
      root,
      fakeFetch(bytes).transport,
      locks,
      channelPair()[0],
    );
    await c.restore();
    const snapshot = get(c);
    expect(snapshot.records.map((r) => r.versionId)).toEqual([
      input.versionId,
      otherInput.versionId,
    ]);
    expect(snapshot.records.every((r) => r.state === "complete")).toBe(true);
    expect(fileOf(root)).toEqual(bytes);
    expect(root.dirs.get("downloads")?.files.get(otherInput.versionId)).toEqual(
      otherBytes,
    );
  });

  test("remove in one tab stops the other's transfer and deletes the file", async () => {
    const root = new FakeDir();
    const locks = new FakeLocks();
    const [channelA, channelB] = channelPair();
    const gate = deferred();
    const first = fakeFetch(bytes, {
      chunk: 8,
      gates: Array(8).fill(gate.promise),
    });
    const a = tabStore(root, first.transport, locks, channelA);
    const b = tabStore(root, fakeFetch(bytes).transport, locks, channelB);
    await b.restore();
    await a.start(input);
    // B picks the record up from the index-change message, then sees it
    // downloading through A's progress posts.
    await waitFor(() => get(b).records[0]?.state === "downloading");
    await b.remove(input.versionId);
    gate.resolve();
    await waitFor(
      () => get(a).records.length === 0 && get(b).records.length === 0,
    );
    expect(fileOf(root)).toBeUndefined();
  });

  test("resume in a second tab does not start a second fetch", async () => {
    const root = new FakeDir();
    await seedIndex(
      root,
      [{ ...input, written: 16, state: "paused" }],
      bytes.subarray(0, 16),
    );
    const locks = new FakeLocks();
    const [channelA, channelB] = channelPair();
    const gate = deferred();
    const first = fakeFetch(bytes, {
      chunk: 8,
      gates: Array(8).fill(gate.promise),
    });
    const second = fakeFetch(bytes, { chunk: 8 });
    const a = tabStore(root, first.transport, locks, channelA);
    const b = tabStore(root, second.transport, locks, channelB);
    await a.resume(input.versionId);
    await waitFor(() => get(a).records[0]?.state === "downloading");
    await b.restore();
    await b.resume(input.versionId);
    await Bun.sleep(20);
    expect(second.calls).toHaveLength(0);
    gate.resolve();
    await waitFor(() => get(a).records[0]?.state === "complete");
    expect(fileOf(root)).toEqual(bytes);
  });
});
