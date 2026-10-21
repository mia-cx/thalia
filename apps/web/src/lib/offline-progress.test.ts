import { describe, expect, test } from "bun:test";
import { ORPCError } from "@orpc/client";
import { ServerUnreachable } from "./api.ts";
import {
  createProgressQueue,
  type OfflineProgress,
} from "./offline-progress.ts";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

const update = {
  userId: "mia",
  itemId: "arrival",
  versionId: "original",
  positionSeconds: 600,
  completed: false,
};

describe("offline progress queue", () => {
  test("keeps updates across a reload until the server takes them", async () => {
    const storage = memoryStorage();
    const offline = createProgressQueue({
      storage,
      send: () => Promise.reject(new ServerUnreachable()),
      now: () => new Date("2026-10-21T10:00:00.000Z"),
    });
    offline.record(update);
    expect(await offline.flush("mia")).toBe(1);

    // A reload: a fresh queue over the same storage, now with a server.
    const sent: Omit<OfflineProgress, "userId">[] = [];
    const online = createProgressQueue({
      storage,
      send: async (entry) => {
        sent.push(entry);
      },
    });
    expect(await online.flush("mia")).toBe(0);
    expect(sent).toEqual([
      {
        itemId: "arrival",
        versionId: "original",
        positionSeconds: 600,
        completed: false,
        at: "2026-10-21T10:00:00.000Z",
      },
    ]);
  });

  test("sends only the newest update per Item, and keeps one recorded while sending", async () => {
    const storage = memoryStorage();
    let minute = 0;
    const sent: number[] = [];
    const queue = createProgressQueue({
      storage,
      send: async (entry) => {
        sent.push(entry.positionSeconds);
        if (entry.positionSeconds === 700)
          queue.record({ ...update, positionSeconds: 900, completed: true });
      },
      now: () => new Date(Date.UTC(2026, 9, 21, 10, minute++)),
    });
    queue.record(update);
    queue.record({ ...update, positionSeconds: 700 });
    expect(await queue.flush("mia")).toBe(1);
    expect(await queue.flush("mia")).toBe(0);
    expect(sent).toEqual([700, 900]);
  });

  test("drops what the server refuses for good, and leaves other users' updates", async () => {
    const storage = memoryStorage();
    const refusing = createProgressQueue({
      storage,
      send: () => Promise.reject(new ORPCError("NOT_FOUND")),
    });
    refusing.record(update);
    refusing.record({ ...update, userId: "guest" });
    expect(await refusing.flush("mia")).toBe(0);

    const unreachable = createProgressQueue({
      storage,
      send: () => Promise.reject(new ServerUnreachable()),
    });
    expect(await unreachable.flush("guest")).toBe(1);
  });
});
