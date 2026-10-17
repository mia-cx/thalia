import { and, eq, inArray, isNotNull, notExists } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import {
  files,
  itemAncestors,
  itemFolders,
  libraryRoots,
  versions,
} from "../db/schema/index.ts";

type Connection =
  | Database
  | Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Records a root's scan identity or child asset location after its catalogue write succeeds. */
export async function setItemLocation(
  db: Connection,
  itemId: string,
  rootId: string,
  canonicalFolder: string,
  titleKey: string | null,
) {
  await db
    .insert(itemFolders)
    .values({ itemId, rootId, canonicalFolder, titleKey })
    .onConflictDoUpdate({
      target: [itemFolders.itemId, itemFolders.rootId],
      set: { canonicalFolder, titleKey },
    });
}

/** Retires empty scan identities under the catalogue lock, retaining their folders for asset reads. */
export async function retireEmptyLocations(
  db: Connection,
  libraryId: string,
  itemIds: readonly string[],
) {
  if (itemIds.length === 0) return;
  await db
    .update(itemFolders)
    .set({ titleKey: null })
    .where(
      and(
        isNotNull(itemFolders.titleKey),
        inArray(
          itemFolders.itemId,
          db
            .select({ id: itemAncestors.ancestorId })
            .from(itemAncestors)
            .where(inArray(itemAncestors.descendantId, [...itemIds])),
        ),
        inArray(
          itemFolders.rootId,
          db
            .select({ id: libraryRoots.id })
            .from(libraryRoots)
            .where(eq(libraryRoots.libraryId, libraryId)),
        ),
        notExists(
          db
            .select({ id: files.id })
            .from(itemAncestors)
            .innerJoin(files, eq(files.itemId, itemAncestors.descendantId))
            .innerJoin(
              versions,
              and(
                eq(versions.id, files.versionId),
                eq(versions.origin, "imported"),
              ),
            )
            .where(
              and(
                eq(itemAncestors.ancestorId, itemFolders.itemId),
                eq(files.rootId, itemFolders.rootId),
              ),
            ),
        ),
      ),
    );
}

/** Reads the root-specific identity, independently of the Item's current home. */
export async function itemLocation(
  db: Connection,
  itemId: string,
  rootId: string,
) {
  const [location] = await db
    .select()
    .from(itemFolders)
    .where(and(eq(itemFolders.itemId, itemId), eq(itemFolders.rootId, rootId)));
  return location;
}
