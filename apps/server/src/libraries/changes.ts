import { lstat } from "node:fs/promises";
import { posix } from "node:path";
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import {
  artwork,
  files,
  itemAncestors,
  itemFolders,
  items,
  libraries,
  providerIds as providerIdRows,
  type ScanChange,
  versions,
} from "../db/schema/index.ts";
import {
  type DeletedArtworkFile,
  deleteItemSubtree,
  pruneEmptiedItems,
} from "../db/tree.ts";
import { itemLocation, setItemLocation } from "./locations.ts";
import { absolutePath, assetRoots, rootedKey } from "./roots.ts";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Connection = Database | Transaction;

const rootItemId = async (db: Connection, itemId: string): Promise<string> => {
  const [root] = await db
    .select({ id: items.id })
    .from(itemAncestors)
    .innerJoin(items, eq(itemAncestors.ancestorId, items.id))
    .where(and(eq(itemAncestors.descendantId, itemId), eq(items.kind, "show")))
    .limit(1);
  return root?.id ?? itemId;
};

/** Reports whether a library-relative path lies in another Show or Movie than the given Item. */
export async function leavesRoot(
  db: Connection,
  rootId: string,
  itemId: string,
  path: string,
): Promise<boolean> {
  const folders: string[] = [];
  for (
    let folder = posix.dirname(path);
    folder !== ".";
    folder = posix.dirname(folder)
  )
    folders.push(folder);
  if (folders.length === 0) return false;
  const [root] = await db
    .select({ id: items.id })
    .from(items)
    .innerJoin(itemFolders, eq(itemFolders.itemId, items.id))
    .where(
      and(
        eq(itemFolders.rootId, rootId),
        isNull(items.parentId),
        inArray(itemFolders.canonicalFolder, folders),
      ),
    )
    .orderBy(desc(sql`length(${itemFolders.canonicalFolder})`))
    .limit(1);
  return root !== undefined && root.id !== (await rootItemId(db, itemId));
}

/**
 * Reports whether a root holds only Files an early scan recorded from Files
 * this batch moves in: each sits at a move's destination with the size and
 * mtime of the File moving there, which a rename keeps.
 */
const isEarlyDuplicate = async (
  db: Connection,
  libraryId: string,
  rootId: string,
  movedFrom: ReadonlyMap<string, string>,
): Promise<boolean> => {
  const stamp = (file: { bytes: bigint; modifiedAt: Date }) =>
    `${file.bytes}:${file.modifiedAt.getTime()}`;
  const held = await db
    .select({
      rootId: files.rootId,
      path: files.path,
      bytes: files.bytes,
      modifiedAt: files.modifiedAt,
    })
    .from(files)
    .innerJoin(itemAncestors, eq(itemAncestors.descendantId, files.itemId))
    .where(
      and(eq(itemAncestors.ancestorId, rootId), eq(files.libraryId, libraryId)),
    );
  const pairs: [string, string][] = [];
  for (const file of held) {
    const from = movedFrom.get(rootedKey(file));
    if (from === undefined) return false;
    // A move stays in its root.
    pairs.push([rootedKey({ rootId: file.rootId, path: from }), stamp(file)]);
  }
  const sources = await db
    .select({
      rootId: files.rootId,
      path: files.path,
      bytes: files.bytes,
      modifiedAt: files.modifiedAt,
    })
    .from(files)
    .where(
      and(
        eq(files.libraryId, libraryId),
        inArray(files.path, [...movedFrom.values()]),
      ),
    );
  const sourceStamps = new Map(
    sources.map((file) => [rootedKey(file), stamp(file)]),
  );
  return pairs.every(([from, held]) => sourceStamps.get(from) === held);
};

/** Removes one File, or its Version when no other File remains, and returns the Item that may now be empty. */
export const removeFile = async (
  db: Connection,
  file: typeof files.$inferSelect,
): Promise<string | undefined> => {
  const [sibling] = await db
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.versionId, file.versionId), ne(files.id, file.id)))
    .limit(1);
  if (sibling !== undefined) {
    await db.delete(files).where(eq(files.id, file.id));
    return undefined;
  }
  await db.delete(versions).where(eq(versions.id, file.versionId));
  return file.itemId;
};

const requireRelativePath = (path: string, allowDot: boolean): string => {
  if (
    path === "" ||
    path.includes("\0") ||
    posix.isAbsolute(path) ||
    path.split("/").includes("..")
  )
    throw new AuthError("INVALID_INPUT");
  const normalized = posix.normalize(path);
  if (normalized === "." && !allowDot) throw new AuthError("INVALID_INPUT");
  return normalized;
};

const providerIdPairs = (providerIds: Record<string, string>) =>
  Object.entries(providerIds).filter(
    ([provider, value]) => provider !== "" && value !== "",
  );

/** Finds one server Item of the requested kind from explicit provider ids; derived metadata ids never identify a scan. */
export async function findItemByProviderIds(
  db: Connection,
  kind: "movie" | "show",
  providerIds: Record<string, string>,
): Promise<typeof items.$inferSelect | undefined> {
  const pairs = providerIdPairs(providerIds);
  if (pairs.length === 0) return undefined;
  const rows = await db
    .select({ item: items })
    .from(providerIdRows)
    .innerJoin(items, eq(providerIdRows.itemId, items.id))
    .where(
      and(
        eq(items.kind, kind),
        eq(providerIdRows.metadataDerived, false),
        or(
          ...pairs.map(([provider, value]) =>
            and(
              eq(providerIdRows.provider, provider),
              eq(providerIdRows.value, value),
            ),
          ),
        ),
      ),
    );
  const matched = new Map(rows.map((row) => [row.item.id, row.item]));
  if (matched.size > 1) throw new AuthError("CONFLICT");
  return matched.values().next().value;
}

/**
 * Upserts explicit provider ids on one Item and reports whether any changed.
 * With `fillOnly`, an id already asserted explicitly keeps its value: folder
 * tags fill gaps but never undo a webhook's correction.
 */
export async function setItemProviderIds(
  db: Connection,
  itemId: string,
  providerIds: Record<string, string>,
  { fillOnly = false }: { fillOnly?: boolean } = {},
): Promise<boolean> {
  let changed = false;
  for (const [provider, value] of providerIdPairs(providerIds)) {
    const [existing] = await db
      .select({
        value: providerIdRows.value,
        metadataDerived: providerIdRows.metadataDerived,
      })
      .from(providerIdRows)
      .where(
        and(
          eq(providerIdRows.itemId, itemId),
          eq(providerIdRows.provider, provider),
        ),
      );
    // Scan input is explicit: an equal derived value still becomes owned.
    if (
      existing !== undefined &&
      !existing.metadataDerived &&
      (fillOnly || existing.value === value)
    )
      continue;
    await db
      .insert(providerIdRows)
      .values({ provider, value, itemId, metadataDerived: false })
      .onConflictDoUpdate({
        target: [providerIdRows.itemId, providerIdRows.provider],
        targetWhere: sql`${providerIdRows.itemId} is not null`,
        set: { value, metadataDerived: false },
      });
    changed = true;
  }
  return changed;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Updates an Item folder and title key, and re-keys colocated artwork that moved with it. */
export async function updateItemCanonicalFolder(
  db: Connection,
  item: typeof items.$inferSelect,
  canonicalFolder: string,
  titleKey: string = "",
  rootIds?: readonly string[],
): Promise<void> {
  const tailPattern = /(?:^|\/)(\.thalia\/artwork\/.+)$/;
  const roots = (await assetRoots(db, item.id)).filter(
    (root) => rootIds === undefined || rootIds.includes(root.id),
  );
  const inRoot = (rootId: string, storageKey: string) =>
    absolutePath(db, { rootId, path: storageKey });
  const rows = await db
    .select({ id: artwork.id, storageKey: artwork.storageKey })
    .from(artwork)
    .where(and(eq(artwork.itemId, item.id), eq(artwork.backend, "colocated")));
  for (const row of rows) {
    const tail = tailPattern.exec(row.storageKey)?.[1];
    if (tail === undefined) throw new Error("Invalid artwork storage key.");
    const nextStorageKey = posix.join(canonicalFolder, tail);
    // The file moved with the Item folder in whichever root actually holds it.
    let holder: string | undefined;
    for (const root of roots) {
      if (await pathExists(await inRoot(root.id, row.storageKey))) {
        holder = root.id;
        break;
      }
    }
    if (
      holder === undefined ||
      (await pathExists(await inRoot(holder, nextStorageKey)))
    ) {
      await db
        .update(artwork)
        .set({ storageKey: nextStorageKey })
        .where(eq(artwork.id, row.id));
    }
  }
  for (const root of roots)
    await setItemLocation(db, item.id, root.id, canonicalFolder, titleKey);
  await db
    .update(items)
    .set({ updatedAt: new Date() })
    .where(eq(items.id, item.id));
}

/** Applies queued moves and deletes before a directory scan writes its result. */
export async function applyScanChanges(
  db: Connection,
  libraryId: string,
  changes: readonly ScanChange[],
  deletedArtwork: DeletedArtworkFile[] = [],
): Promise<string[]> {
  const [library] = await db
    .select({ medium: libraries.medium })
    .from(libraries)
    .where(eq(libraries.id, libraryId));
  if (!library) throw new AuthError("NOT_FOUND");
  const kind = library.medium === "movies" ? "movie" : "show";
  const normalized = changes.map((change) => ({
    change,
    path: requireRelativePath(
      change.path,
      change.kind === "delete" && change.target === "item",
    ),
    previousPath:
      change.kind === "move"
        ? requireRelativePath(change.previousPath, false)
        : undefined,
  }));
  // Destination to source, keyed in the move's root.
  const movedFrom = new Map(
    normalized.flatMap(({ change, path, previousPath }) =>
      previousPath === undefined
        ? []
        : [[rootedKey({ rootId: change.rootId, path }), previousPath] as const],
    ),
  );
  const fileAt = async (rootId: string, at: string) => {
    const [file] = await db
      .select()
      .from(files)
      .where(
        and(
          eq(files.libraryId, libraryId),
          eq(files.rootId, rootId),
          eq(files.path, at),
        ),
      );
    return file;
  };
  const emptiedItemIds: string[] = [];
  for (const { change, path, previousPath } of normalized) {
    if (change.kind === "add") continue;
    if (change.kind === "move") {
      if (previousPath === undefined) throw new AuthError("INVALID_INPUT");
      const file = await fileAt(change.rootId, previousPath);
      const destination = await fileAt(change.rootId, path);
      if (file && destination) {
        if (file.id === destination.id) continue;
        // A collision replaces only the colliding Item. The exception is a
        // duplicate root an early scan made of a moved folder.
        if (destination.itemId === file.itemId) {
          await db
            .delete(versions)
            .where(eq(versions.id, destination.versionId));
        } else {
          const destinationRootId = await rootItemId(db, destination.itemId);
          const duplicate =
            destinationRootId !== (await rootItemId(db, file.itemId)) &&
            (await isEarlyDuplicate(
              db,
              libraryId,
              destinationRootId,
              movedFrom,
            ));
          const targetId = duplicate ? destinationRootId : destination.itemId;
          const held = await db
            .select({ file: files })
            .from(files)
            .innerJoin(
              itemAncestors,
              eq(itemAncestors.descendantId, files.itemId),
            )
            .where(
              and(
                eq(itemAncestors.ancestorId, targetId),
                eq(files.rootId, change.rootId),
              ),
            );
          const emptied = [];
          for (const { file } of held) {
            const id = await removeFile(db, file);
            if (id !== undefined) emptied.push(id);
          }
          if (duplicate)
            await pruneEmptiedItems(db, [...emptied, targetId], deletedArtwork);
          else
            for (const id of emptied) {
              const ancestors = await db
                .select({ id: itemAncestors.ancestorId })
                .from(itemAncestors)
                .where(eq(itemAncestors.descendantId, id));
              emptiedItemIds.push(...ancestors.map((ancestor) => ancestor.id));
              const [survivor] = await db
                .select({ id: versions.id })
                .from(versions)
                .where(eq(versions.itemId, id))
                .limit(1);
              // Keep the destination Show until this scan has inserted its replacement Episode.
              if (survivor === undefined)
                await deleteItemSubtree(db, id, deletedArtwork);
            }
        }
      }
      if (file) {
        // A move into another Show or Movie leaves its source, and the
        // destination folder's scan adds it there. Progress stays behind.
        if (await leavesRoot(db, change.rootId, file.itemId, path)) {
          const emptied = await removeFile(db, file);
          if (emptied !== undefined) emptiedItemIds.push(emptied);
          continue;
        }
        await db.update(files).set({ path }).where(eq(files.id, file.id));
        const [item] = await db
          .select()
          .from(items)
          .where(eq(items.id, file.itemId));
        if (
          item &&
          (await itemLocation(db, item.id, change.rootId))?.canonicalFolder ===
            posix.dirname(previousPath)
        ) {
          await updateItemCanonicalFolder(db, item, posix.dirname(path), "", [
            change.rootId,
          ]);
        }
        continue;
      }
      const item = await findItemByProviderIds(db, kind, change.providerIds);
      if (
        item &&
        (await itemLocation(db, item.id, change.rootId))?.canonicalFolder ===
          posix.dirname(previousPath)
      ) {
        await updateItemCanonicalFolder(db, item, posix.dirname(path), "", [
          change.rootId,
        ]);
      }
      continue;
    }
    if (change.target === "file") {
      const file = await fileAt(change.rootId, path);
      if (!file) continue;
      const emptied = await removeFile(db, file);
      if (emptied !== undefined) emptiedItemIds.push(emptied);
      continue;
    }
    const found = await findItemByProviderIds(db, kind, change.providerIds);
    const candidates =
      found !== undefined
        ? [found]
        : await db
            .select({ item: items })
            .from(items)
            .innerJoin(itemFolders, eq(itemFolders.itemId, items.id))
            .where(
              and(
                eq(itemFolders.rootId, change.rootId),
                isNull(items.parentId),
                eq(itemFolders.canonicalFolder, path),
              ),
            )
            .then((rows) => rows.map((row) => row.item));
    for (const item of candidates) {
      // An Item another root still holds loses only this root's Files.
      const held = await db
        .select({ file: files })
        .from(files)
        .innerJoin(itemAncestors, eq(itemAncestors.descendantId, files.itemId))
        .where(eq(itemAncestors.ancestorId, item.id));
      if (held.every(({ file }) => file.rootId === change.rootId)) {
        await deleteItemSubtree(db, item.id, deletedArtwork);
        continue;
      }
      for (const { file } of held) {
        if (file.rootId !== change.rootId) continue;
        const emptied = await removeFile(db, file);
        if (emptied !== undefined) emptiedItemIds.push(emptied);
      }
    }
  }
  return [...new Set(emptiedItemIds)];
}
