import { and, asc, eq, type SQLWrapper, sql } from "drizzle-orm";
import { publishEvent } from "../api/events.ts";
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

/** Library membership includes Versions on the Item itself and its descendants, once per Item. */
export function inLibraries(
  libraryIds: readonly string[],
  itemId: SQLWrapper = sql.raw('"items"."id"'),
) {
  if (libraryIds.length === 0) return sql<boolean>`false`;
  return sql<boolean>`exists (
    select 1 from item_ancestors membership
    join versions member_version on member_version.item_id = membership.descendant_id
    where membership.ancestor_id = ${itemId}
      and member_version.library_id in (${sql.join(
        libraryIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
  )`;
}

/** Configuration comes from the oldest imported copy, including copies below containers. */
export function homeLibraryId(itemId: SQLWrapper = sql.raw('"items"."id"')) {
  return sql<string | null>`(
    select home_version.library_id from item_ancestors home_ancestor
    join versions home_version on home_version.item_id = home_ancestor.descendant_id
    where home_ancestor.ancestor_id = ${itemId} and home_version.origin = 'imported'
    order by home_version.created_at, home_version.id limit 1
  )`;
}

/** Publishes shared mutations to every Library currently holding the Item. */
export async function publishItemChange(db: Connection, itemId: string) {
  for (const libraryId of await memberLibraryIds(db, itemId))
    await publishEvent(db, { kind: "library.changed", libraryId });
}

/** Every Library that must refresh after a shared Item changes. */
export async function memberLibraryIds(db: Connection, itemId: string) {
  const rows = await db
    .selectDistinct({ libraryId: versions.libraryId })
    .from(itemAncestors)
    .innerJoin(versions, eq(versions.itemId, itemAncestors.descendantId))
    .where(eq(itemAncestors.ancestorId, itemId));
  return rows.map((row) => row.libraryId);
}

/** The home root belongs to the oldest copy's Library, then follows that Library's root order. */
export async function homeLocation(db: Connection, itemId: string) {
  const [location] = await db
    .select({
      libraryId: libraryRoots.libraryId,
      rootId: libraryRoots.id,
      path: libraryRoots.path,
      canonicalFolder: itemFolders.canonicalFolder,
    })
    .from(itemAncestors)
    .innerJoin(
      versions,
      and(
        eq(versions.itemId, itemAncestors.descendantId),
        eq(versions.origin, "imported"),
      ),
    )
    .innerJoin(files, eq(files.versionId, versions.id))
    .innerJoin(libraryRoots, eq(libraryRoots.id, files.rootId))
    .innerJoin(
      itemFolders,
      and(
        eq(itemFolders.itemId, itemAncestors.ancestorId),
        eq(itemFolders.rootId, libraryRoots.id),
      ),
    )
    .where(
      and(
        eq(itemAncestors.ancestorId, itemId),
        eq(libraryRoots.libraryId, homeLibraryId(sql`${itemId}::uuid`)),
      ),
    )
    .orderBy(asc(libraryRoots.position), asc(libraryRoots.id))
    .limit(1);
  return location;
}
