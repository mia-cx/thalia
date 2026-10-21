import { index, pgTable, unique, uuid } from "drizzle-orm/pg-core";
import { owned } from "./common.ts";
import { items, libraries } from "./core.ts";

/**
 * Jellyfin item ids, each a UUIDv5 of an Item and a Library holding a Version
 * on or below it (ADR 0016). A hash cannot be read backwards, so the pairs
 * are recorded and an id a client sends back is looked up here.
 */
export const jellyfinItems = pgTable(
  "jellyfin_items",
  {
    id: uuid("id").primaryKey(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, owned),
    libraryId: uuid("library_id")
      .notNull()
      .references(() => libraries.id, owned),
  },
  (table) => [
    unique("jellyfin_items_pair_unique").on(table.itemId, table.libraryId),
    index("jellyfin_items_library_idx").on(table.libraryId),
  ],
);
