import { client } from "./api.ts";
import { readFailure } from "./errors.ts";

/** One progress update made without the server, dated when it happened. */
export type OfflineProgress = {
  userId: string;
  itemId: string;
  versionId: string;
  positionSeconds: number;
  completed: boolean;
  /** When it happened, as an ISO date-time. */
  at: string;
};

export type ProgressQueueDeps = {
  storage: Pick<Storage, "getItem" | "setItem">;
  /** Hands one update to the server; throws when it isn't taken. */
  send: (update: Omit<OfflineProgress, "userId">) => Promise<unknown>;
  now?: () => Date;
};

const storageKey = "thalia.offline-progress";

const sameItem = (a: OfflineProgress, b: OfflineProgress) =>
  a.userId === b.userId && a.itemId === b.itemId;

/**
 * A durable queue of progress made offline, kept in storage until the server
 * takes it. Only the newest update per user and Item is kept, since the
 * server drops anything older than what it holds anyway.
 */
export function createProgressQueue(deps: ProgressQueueDeps) {
  const read = (): OfflineProgress[] => {
    try {
      const parsed: unknown = JSON.parse(
        deps.storage.getItem(storageKey) ?? "[]",
      );
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  const write = (entries: OfflineProgress[]) => {
    try {
      deps.storage.setItem(storageKey, JSON.stringify(entries));
    } catch {
      // Blocked storage loses offline progress; playback goes on.
    }
  };
  const pending = (userId: string) =>
    read().filter((entry) => entry.userId === userId);

  let flushing: Promise<number> | undefined;

  /**
   * Sends a user's queued updates, oldest first. An unreachable or failing
   * server stops the run and keeps the rest for the next one; an update the
   * server refuses outright (the Item is gone, or no longer playable) is
   * dropped. Answers how many of the user's updates remain.
   */
  async function run(userId: string): Promise<number> {
    for (const entry of pending(userId)) {
      const { userId: _, ...update } = entry;
      try {
        await deps.send(update);
      } catch (error) {
        const { code } = readFailure(error);
        if (
          code === "UNREACHABLE" ||
          code === "UNKNOWN" ||
          code === "UNAUTHORIZED"
        )
          break;
      }
      // A newer update recorded while this one was sending stays queued.
      write(
        read().filter(
          (queued) => !(sameItem(queued, entry) && queued.at === entry.at),
        ),
      );
    }
    return pending(userId).length;
  }

  return {
    /** Queues an update dated now, replacing any older one for the same Item. */
    record(update: Omit<OfflineProgress, "at">): void {
      const entry = {
        ...update,
        at: (deps.now?.() ?? new Date()).toISOString(),
      };
      write([...read().filter((queued) => !sameItem(queued, entry)), entry]);
    },
    /** Sends what is queued for `userId`; concurrent calls share one run. */
    flush(userId: string): Promise<number> {
      flushing ??= run(userId).finally(() => {
        flushing = undefined;
      });
      return flushing;
    },
  };
}

/** The browser's offline progress queue, sending through the API client. */
export const offlineProgress = createProgressQueue({
  get storage() {
    return localStorage;
  },
  send: (update) => client.playback.syncProgress(update),
});

const retryMs = 10_000;

/**
 * Sends `userId`'s offline progress now, when the browser comes back online,
 * and every ten seconds while any is left. Answers the function that stops it.
 */
export function syncOfflineProgress(userId: string): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const flush = async () => {
    clearTimeout(timer);
    const left = await offlineProgress.flush(userId);
    if (left > 0 && !stopped) timer = setTimeout(flush, retryMs);
  };
  const online = () => void flush();
  addEventListener("online", online);
  void flush();
  return () => {
    stopped = true;
    clearTimeout(timer);
    removeEventListener("online", online);
  };
}
