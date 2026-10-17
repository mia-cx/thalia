import { eq, getTableColumns, type SQL, sql } from "drizzle-orm";
import { setItemLocation } from "../libraries/locations.ts";
import { homeLibraryId } from "../libraries/membership.ts";
import { rootsOf } from "../libraries/roots.ts";
import type { Database } from "./client.ts";
import { files, items, libraries, versions } from "./schema/index.ts";
import { insertItem as insertCatalogueItem } from "./tree.ts";

type Connection =
  | Database
  | Parameters<Parameters<Database["transaction"]>[0]>[0];
type Input = Parameters<typeof insertCatalogueItem>[1] & {
  libraryId: string;
  canonicalFolder: string;
  titleKey?: string;
  withVersion?: boolean;
};

type RawInput = Omit<typeof items.$inferInsert, "addedAt"> & {
  addedAt?: Date | SQL;
} & {
  libraryId: string;
  canonicalFolder: string;
  titleKey?: string;
  withVersion?: boolean;
};

/** Seeds standalone test Items through the real tree writer so closure and locations exist. */
export async function insertItems(
  db: Connection,
  input: RawInput | readonly RawInput[],
) {
  const rows = [];
  for (const { addedAt, ...value } of [input].flat()) {
    if (value.kind === "movie" || value.kind === "show")
      rows.push(
        await insertItem(db, {
          ...value,
          kind: value.kind,
          parentId: null,
          extension: {},
        }),
      );
    else {
      if (!value.parentId) throw new Error("Child fixture needs a parent.");
      rows.push(
        value.kind === "season"
          ? await insertItem(db, {
              ...value,
              kind: "season",
              parentId: value.parentId,
              extension: { seasonNumber: 1 },
            })
          : await insertItem(db, {
              ...value,
              kind: "episode",
              parentId: value.parentId,
              extension: { episodeNumber: 1 },
            }),
      );
    }
    const row = rows.at(-1);
    if (row && addedAt !== undefined)
      await db.update(items).set({ addedAt }).where(eq(items.id, row.id));
  }
  return rows;
}

const locationField = (field: "canonical_folder" | "title_key") => sql<string>`(
  select location.${sql.identifier(field)} from item_folders location
  join library_roots root on root.id = location.root_id where location.item_id = "items"."id"
  order by (root.library_id = ${homeLibraryId()}) desc nulls last, root.position, root.id limit 1
)`;

/** Test assertions read locations separately from server-owned catalogue columns. */
export const itemFixtureFields = {
  ...getTableColumns(items),
  libraryId: homeLibraryId(),
  canonicalFolder: locationField("canonical_folder"),
  titleKey: locationField("title_key"),
};

/** Builds a test tree and its root locations; membership still requires real Versions. */
export async function insertItem(db: Connection, input: Input) {
  const {
    libraryId,
    canonicalFolder,
    titleKey = "",
    withVersion = false,
    ...values
  } = input;
  const [library] = await db
    .select()
    .from(libraries)
    .where(eq(libraries.id, libraryId));
  if (library === undefined) throw new Error("Library not found.");
  const item = await insertCatalogueItem(db, values);
  for (const root of await rootsOf(db, libraryId))
    await setItemLocation(
      db,
      item.id,
      root.id,
      canonicalFolder,
      input.kind === "movie" || input.kind === "show" ? titleKey : null,
    );
  if (withVersion && (item.kind === "movie" || item.kind === "episode")) {
    const [root] = await rootsOf(db, libraryId);
    if (!root) throw new Error("Missing fixture root.");
    const [version] = await db
      .insert(versions)
      .values({
        itemId: item.id,
        itemKind: item.kind,
        libraryId,
        label: "Original",
        format: "video",
        bytes: 1n,
      })
      .returning();
    if (!version) throw new Error("Missing fixture Version.");
    await db.insert(files).values({
      itemId: item.id,
      versionId: version.id,
      libraryId,
      rootId: root.id,
      path: `${canonicalFolder}/${item.id}.mkv`,
      order: 0,
      bytes: 1n,
      modifiedAt: new Date(),
    });
  }
  return { ...item, libraryId, canonicalFolder, titleKey };
}
