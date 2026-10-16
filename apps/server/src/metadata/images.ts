import type { MetadataResult } from "@thalia/plugin-api";
import { and, eq } from "drizzle-orm";
import { server } from "../auth/access.ts";
import { AuthError } from "../auth/errors.ts";
import { requirePermission } from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import { artwork, items } from "../db/schema/index.ts";
import { publishItemChange } from "../libraries/membership.ts";
import {
  ArtworkInputError,
  readArtworkOriginal,
  removeSelectedArtwork,
  storeArtworkBytes,
} from "./artwork-store.ts";

type ImageType = MetadataResult["artwork"][number]["type"];

async function owner(
  db: Database,
  actorId: string,
  itemId: string,
  permission: "view" | "metadata:edit",
) {
  const [item] = await db
    .select({ id: items.id })
    .from(items)
    .where(eq(items.id, itemId));
  await requirePermission(
    db,
    actorId,
    permission,
    item ? { type: "item", id: itemId } : server,
  );
  return item;
}

/** Lists selected originals visible to the caller; absent core image owners have no images. */
export async function listItemImages(
  db: Database,
  actorId: string,
  itemId: string,
) {
  if ((await owner(db, actorId, itemId, "view")) === undefined) return [];
  const rows = await db
    .select()
    .from(artwork)
    .where(and(eq(artwork.itemId, itemId), eq(artwork.selected, true)))
    .orderBy(artwork.type);
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      type: row.type,
      width: row.width,
      height: row.height,
      path: row.storageKey,
      bytes: (await readArtworkOriginal(db, row.id))?.bytes.byteLength ?? 0,
    })),
  );
}

/** Replaces one selected original after checking metadata-management permission. */
export async function uploadItemImage(
  db: Database,
  actorId: string,
  itemId: string,
  type: ImageType,
  bytes: Uint8Array,
) {
  const item = await owner(db, actorId, itemId, "metadata:edit");
  if (item === undefined) return;
  try {
    await storeArtworkBytes(db, itemId, type, bytes);
  } catch (error) {
    if (error instanceof ArtworkInputError)
      throw new AuthError("INVALID_INPUT");
    throw error;
  }
  await publishItemChange(db, itemId);
}

/** Deletes one selected original and its stored file after checking metadata-management permission. */
export async function deleteItemImage(
  db: Database,
  actorId: string,
  itemId: string,
  type: ImageType,
) {
  const item = await owner(db, actorId, itemId, "metadata:edit");
  if (item === undefined) return;
  if (await removeSelectedArtwork(db, itemId, type))
    await publishItemChange(db, itemId);
}
