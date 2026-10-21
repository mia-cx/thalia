import { eq, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { items } from "../db/schema/index.ts";
import { resolveAccess, server } from "./access.ts";
import { AuthError } from "./errors.ts";
import { loadCaller } from "./permissions.ts";

type Queryable = Pick<Database, "select">;
type Caller = Awaited<ReturnType<typeof loadCaller>>;

const uuids = (ids: readonly string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

// The objects of one type holding a `view` rule for the caller, split by how the rules on each decide.
function decisions(caller: Caller, type: "library" | "item") {
  const ids = new Set<string>();
  for (const rule of caller.rules) {
    const id = type === "library" ? rule.libraryId : rule.itemId;
    if (rule.action === "view" && id !== null) ids.add(id);
  }
  const allowed: string[] = [];
  const denied: string[] = [];
  for (const id of ids)
    (resolveAccess({ ...caller, action: "view", chain: [{ type, id }] }).allowed
      ? allowed
      : denied
    ).push(id);
  return { allowed, denied };
}

/**
 * Loads the caller's `view` rules once and compiles them to SQL, so a list
 * filters every Item in the database instead of checking Items one at a time.
 *
 * A Version is viewable when the nearest Item rule on its Item's chain allows
 * it or, with none, its Library's rule or else the server's does (ADR 0016).
 * An Item is visible when it or an Item below it holds a viewable Version, so
 * a Library, show or Season appears for what it holds and lists only that.
 */
export async function loadVisibility(db: Queryable, userId: string) {
  const caller = await loadCaller(db, userId);
  const serverAllowed = resolveAccess({
    ...caller,
    action: "view",
    chain: [server],
  }).allowed;
  const libraryRules = decisions(caller, "library");
  const itemRules = decisions(caller, "item");
  const ruled = [...itemRules.allowed, ...itemRules.denied];

  const libraryAllowed = (libraryId: SQLWrapper): SQL => {
    if (!caller.enabled) return sql`false`;
    if (caller.admin) return sql`true`;
    if (serverAllowed)
      return libraryRules.denied.length
        ? sql`${libraryId} not in (${uuids(libraryRules.denied)})`
        : sql`true`;
    return libraryRules.allowed.length
      ? sql`${libraryId} in (${uuids(libraryRules.allowed)})`
      : sql`false`;
  };
  // Uncorrelated, so Postgres hashes each subtree once per statement.
  const below = (ids: readonly string[]) =>
    sql`(select ruled.descendant_id from item_ancestors ruled where ruled.ancestor_id in (${uuids(ids)}))`;
  // The nearest Item rule decides, so an allow below a deny shows its subtree and a deny below an allow hides it.
  const allowedBelow = itemRules.denied.length
    ? sql`(
        select nearest.descendant_id from (
          select distinct on (ruled.descendant_id) ruled.descendant_id, ruled.ancestor_id
          from item_ancestors ruled where ruled.ancestor_id in (${uuids(ruled)})
          order by ruled.descendant_id, ruled.depth
        ) nearest where nearest.ancestor_id in (${uuids(itemRules.allowed)})
      )`
    : below(itemRules.allowed);
  const versionViewable = (version: string): SQL => {
    const library = libraryAllowed(sql.raw(`${version}.library_id`));
    if (ruled.length === 0) return library;
    const item = sql.raw(`${version}.item_id`);
    const inherited = sql`(${item} not in ${below(ruled)} and ${library})`;
    return itemRules.allowed.length
      ? sql`(${item} in ${allowedBelow} or ${inherited})`
      : inherited;
  };

  const item = (
    itemId: SQLWrapper = sql.raw('"items"."id"'),
    libraryIds?: readonly string[],
  ): SQL<boolean> => {
    if (libraryIds?.length === 0) return sql<boolean>`false`;
    return sql<boolean>`exists (
      select 1 from item_ancestors visible_member
      join versions visible_version on visible_version.item_id = visible_member.descendant_id
      where visible_member.ancestor_id = ${itemId}
        ${libraryIds === undefined ? sql`` : sql`and visible_version.library_id in (${uuids(libraryIds)})`}
        and ${versionViewable("visible_version")}
    )`;
  };
  const viewable = (
    itemId: SQLWrapper = sql.raw('"items"."id"'),
  ): SQL<boolean> => {
    if (!caller.enabled) return sql<boolean>`false`;
    if (caller.admin) return sql<boolean>`true`;
    const byLibrary = sql`exists (
      select 1 from item_ancestors viewable_member
      join versions viewable_version on viewable_version.item_id = viewable_member.descendant_id
      where viewable_member.ancestor_id = ${itemId}
        and ${libraryAllowed(sql.raw("viewable_version.library_id"))}
    )`;
    if (ruled.length === 0) return sql<boolean>`${byLibrary}`;
    const decides = itemRules.allowed.length
      ? sql`nearest_rule.ancestor_id in (${uuids(itemRules.allowed)})`
      : sql`false`;
    return sql<boolean>`coalesce((
      select ${decides} from item_ancestors nearest_rule
      where nearest_rule.descendant_id = ${itemId}
        and nearest_rule.ancestor_id in (${uuids(ruled)})
      order by nearest_rule.depth limit 1
    ), ${byLibrary})`;
  };

  return {
    /** Holds when the Item or one below it has a Version the caller may view, in one of `libraryIds` when given. Lists show these. */
    item,
    /**
     * Holds when the caller may view the Item itself, as the single-Item check
     * decides. A listed Item where this fails is a container shown only for
     * what it holds: its title and artwork, nothing more.
     */
    viewable,
    /** Holds when the caller may open the Item: view it, or see it as a container. */
    opens(itemId: SQLWrapper = sql.raw('"items"."id"')): SQL<boolean> {
      return sql<boolean>`(${item(itemId)} or ${viewable(itemId)})`;
    },
    /** Holds when the caller may view the Library or it holds a visible Item. */
    library(libraryId: SQLWrapper = sql.raw('"libraries"."id"')): SQL<boolean> {
      return sql<boolean>`(${libraryAllowed(libraryId)} or exists (
        select 1 from versions library_version
        where library_version.library_id = ${libraryId}
          and ${versionViewable("library_version")}
      ))`;
    },
  };
}

/** The caller's compiled `view` rules; see `loadVisibility`. */
export type Visibility = Awaited<ReturnType<typeof loadVisibility>>;

/** Throws NOT_FOUND for a missing Item and FORBIDDEN unless the caller can see it, if only as a container. */
export async function requireVisibleItem(
  db: Queryable,
  userId: string,
  itemId: string,
) {
  const visibility = await loadVisibility(db, userId);
  const [row] = await db
    .select({ visible: visibility.opens() })
    .from(items)
    .where(eq(items.id, itemId));
  if (row === undefined) throw new AuthError("NOT_FOUND");
  if (!row.visible) throw new AuthError("FORBIDDEN");
}
