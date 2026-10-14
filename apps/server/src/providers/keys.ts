import { and, eq, inArray, or, sql } from "drizzle-orm";
import { AuthError } from "../auth/errors.ts";
import { requirePermission } from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import type { JsonObject } from "../db/schema/common.ts";
import {
  items,
  seasons,
  settings,
  settingsLockClass,
} from "../db/schema/index.ts";
import { queueProviderFetch } from "../metadata/jobs.ts";

const providersKey = "providers";
const namePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const maxValueLength = 4096;

/** The Item kinds each built-in provider key gives another fetch. */
const requeuedKinds = new Map<string, (typeof items.$inferSelect.kind)[]>([
  ["tmdb", ["movie"]],
  ["tvdb", ["show", "season", "episode"]],
]);

function storedKeys(value: unknown): Record<string, string> {
  const stored: Record<string, string> = Object.create(null);
  if (value === undefined) return stored;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Corrupt provider keys settings row.");
  const keys = (value as Record<string, unknown>).keys;
  if (keys === null || typeof keys !== "object" || Array.isArray(keys))
    throw new Error("Corrupt provider keys settings row.");
  for (const [name, secret] of Object.entries(keys)) {
    if (typeof secret !== "string")
      throw new Error("Corrupt provider keys settings row.");
    stored[name] = secret;
  }
  return stored;
}

function normalizeName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!namePattern.test(normalized)) throw new AuthError("INVALID_INPUT");
  return normalized;
}

async function writeKeys(
  db: Database,
  update: (keys: Record<string, string>) => void,
  afterWrite?: (
    tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  ) => Promise<void>,
) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${settingsLockClass}, hashtext(${providersKey}))`,
    );
    const [row] = await tx
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, providersKey))
      .limit(1);
    const keys = storedKeys(row?.value);
    update(keys);
    const value: JsonObject = { keys };
    await tx
      .insert(settings)
      .values({
        key: providersKey,
        value,
        updatedAt: sql`clock_timestamp()`,
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: sql`clock_timestamp()` },
      });
    if (afterWrite) await afterWrite(tx);
    return Object.keys(keys).sort();
  });
}

/** Lists the provider key names without a caller check; values never leave the server. */
export async function readProviderKeyNames(db: Database) {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, providersKey))
    .limit(1);
  return Object.keys(storedKeys(row?.value)).sort();
}

/** Reads one normalized provider key without exposing it through an API response. */
export async function readProviderKey(
  db: Database,
  name: string,
): Promise<string | undefined> {
  const key = normalizeName(name);
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, providersKey))
    .limit(1);
  return storedKeys(row?.value)[key];
}

/** Stores a key and queues its pending Items for a caller holding manage-server; returns sorted names. */
export async function setProviderKey(
  db: Database,
  actorId: string,
  name: string,
  value: string,
) {
  await requirePermission(db, actorId, "manage-server");
  const key = normalizeName(name);
  if (
    value.trim().length === 0 ||
    value.length > maxValueLength ||
    value.includes("\0")
  )
    throw new AuthError("INVALID_INPUT");
  const kinds = requeuedKinds.get(key);
  return writeKeys(
    db,
    (keys) => {
      keys[key] = value;
    },
    kinds === undefined
      ? undefined
      : async (tx) => {
          // A fresh credential gives unmatched Items another chance without a rescan.
          await tx
            .update(items)
            .set({ metadataState: "pending", updatedAt: new Date() })
            .where(
              and(
                inArray(items.kind, kinds),
                eq(items.metadataState, "unmatched"),
              ),
            );
          const pending = await tx
            .select({ id: items.id, kind: items.kind })
            .from(items)
            .where(
              and(
                inArray(items.kind, kinds),
                eq(items.metadataState, "pending"),
              ),
            );
          const fetchIds = new Set(
            pending
              .filter((item) => item.kind === "movie" || item.kind === "show")
              .map((item) => item.id),
          );
          // A Show fetch walks its tree, even when only a Season or Episode is pending.
          if (key === "tvdb") {
            const parents = await tx
              .selectDistinct({ id: seasons.showId })
              .from(seasons)
              .innerJoin(
                items,
                or(
                  eq(items.id, seasons.itemId),
                  eq(items.parentId, seasons.itemId),
                ),
              )
              .where(eq(items.metadataState, "pending"));
            for (const parent of parents) fetchIds.add(parent.id);
          }
          for (const id of fetchIds) await queueProviderFetch(tx, id);
        },
  );
}

/** Removes one provider key for a caller holding manage-server and returns the sorted names. */
export async function removeProviderKey(
  db: Database,
  actorId: string,
  name: string,
) {
  await requirePermission(db, actorId, "manage-server");
  const key = normalizeName(name);
  return writeKeys(db, (keys) => {
    if (!Object.hasOwn(keys, key)) throw new AuthError("NOT_FOUND");
    delete keys[key];
  });
}
