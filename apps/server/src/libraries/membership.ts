import { type SQLWrapper, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";

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

/** Every Library that must refresh after a shared Item changes. */
export async function memberLibraryIds(db: Connection, itemId: string) {
  const rows = await db.execute<{ libraryId: string }>(sql`
    select distinct v.library_id as "libraryId" from item_ancestors a
    join versions v on v.item_id = a.descendant_id where a.ancestor_id = ${itemId}
  `);
  return rows.map((row) => row.libraryId);
}

/** The home root belongs to the oldest copy's Library, then follows that Library's root order. */
export async function homeLocation(db: Connection, itemId: string) {
  const [location] = await db.execute<{
    libraryId: string;
    rootId: string;
    path: string;
    canonicalFolder: string;
  }>(sql`
    select r.library_id as "libraryId", r.id as "rootId", r.path,
      i.canonical_folder as "canonicalFolder"
    from items i
    join item_ancestors a on a.ancestor_id = i.id
    join versions v on v.item_id = a.descendant_id and v.origin = 'imported'
    join files f on f.version_id = v.id
    join library_roots r on r.id = f.root_id
    where i.id = ${itemId} and r.library_id = ${homeLibraryId(sql`${itemId}::uuid`)}
    order by r.position, r.id limit 1
  `);
  return location;
}
