import { and, eq, inArray, notExists } from "drizzle-orm";
import type { ItemPair } from "../api/views.ts";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import {
  itemAncestors,
  jellyfinItems,
  libraries,
  versions,
} from "../db/schema/index.ts";
import { parseGuid, requiredGuid, toGuid } from "./request.ts";

type Connection = Pick<Database, "select" | "selectDistinct" | "insert">;

// Fixed forever: changing it changes every id a client has cached.
const namespace = "8323c0c3-66eb-43f7-af9b-6bb7a5675f20";

const pairUuid = (itemId: string, libraryId: string) =>
  Bun.randomUUIDv5(`${itemId}:${libraryId}`, namespace);

/** The Jellyfin id of an Item in a Library: a UUIDv5 of the pair, so it never changes. */
export function itemGuid(itemId: string, libraryId: string) {
  return toGuid(pairUuid(itemId, libraryId));
}

// A hash cannot be read backwards, so every Item and Library holding a Version
// on or below it gets its id recorded. Only pairs not yet recorded are read.
async function recordNewPairs(db: Connection) {
  const pairs = await db
    .selectDistinct({
      itemId: itemAncestors.ancestorId,
      libraryId: versions.libraryId,
    })
    .from(itemAncestors)
    .innerJoin(versions, eq(versions.itemId, itemAncestors.descendantId))
    .where(
      notExists(
        db
          .select({ id: jellyfinItems.id })
          .from(jellyfinItems)
          .where(
            and(
              eq(jellyfinItems.itemId, itemAncestors.ancestorId),
              eq(jellyfinItems.libraryId, versions.libraryId),
            ),
          ),
      ),
    );
  if (pairs.length > 0)
    await db
      .insert(jellyfinItems)
      .values(
        pairs.map((pair) => ({
          id: pairUuid(pair.itemId, pair.libraryId),
          ...pair,
        })),
      )
      .onConflictDoNothing();
}

async function lookup(db: Connection, ids: readonly string[]) {
  const rows = await db
    .select({
      id: jellyfinItems.id,
      itemId: jellyfinItems.itemId,
      libraryId: jellyfinItems.libraryId,
    })
    .from(jellyfinItems)
    .where(inArray(jellyfinItems.id, [...ids]));
  return new Map(rows.map(({ id, ...pair }) => [id, pair]));
}

/** Resolves Jellyfin item ids back to their Item and Library; unknown ids drop out. */
export async function resolvePairs(
  db: Connection,
  texts: readonly string[],
): Promise<ItemPair[]> {
  const ids = texts.flatMap((text) => parseGuid(text) ?? []);
  if (ids.length === 0) return [];
  let found = await lookup(db, ids);
  if (ids.some((id) => !found.has(id))) {
    await recordNewPairs(db);
    found = await lookup(db, ids);
  }
  return ids.flatMap((id) => found.get(id) ?? []);
}

/** Resolves one Jellyfin item id; an id naming no Item in a Library is not found. */
export async function resolvePair(
  db: Connection,
  text: string | undefined,
): Promise<ItemPair> {
  const [pair] = await resolvePairs(db, [requiredGuid(text)]);
  if (pair === undefined) throw new AuthError("NOT_FOUND");
  return pair;
}

/** Resolves a folder id: a Library's own id, or an Item in a Library. */
export async function resolveFolder(
  db: Connection,
  text: string | undefined,
): Promise<{ libraryId: string; itemId?: string }> {
  const id = requiredGuid(text);
  const [library] = await db
    .select({ id: libraries.id })
    .from(libraries)
    .where(eq(libraries.id, id));
  if (library !== undefined) return { libraryId: library.id };
  return resolvePair(db, id);
}
