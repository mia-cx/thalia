import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { itemFolders } from "../db/schema/index.ts";

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
