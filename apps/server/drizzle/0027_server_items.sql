-- Catalogue identities are reset; Libraries, roots, accounts and settings survive.
DELETE FROM items;
--> statement-breakpoint
-- Item-targeted jobs cannot refer to the discarded catalogue. Library scans remain usable.
DELETE FROM jobs WHERE payload ? 'itemId';
--> statement-breakpoint
CREATE TABLE "item_folders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"item_id" uuid NOT NULL,
	"root_id" uuid NOT NULL,
	"canonical_folder" text NOT NULL,
	"title_key" text,
	CONSTRAINT "item_folders_identity_unique" UNIQUE("root_id","canonical_folder","title_key"),
	CONSTRAINT "item_folders_item_root_unique" UNIQUE("item_id","root_id")
);
--> statement-breakpoint
ALTER TABLE "items" DROP CONSTRAINT "items_library_id_libraries_id_fk";
--> statement-breakpoint
ALTER TABLE "items" DROP CONSTRAINT "items_parent_fk";
--> statement-breakpoint
ALTER TABLE "versions" DROP CONSTRAINT "versions_item_library_fk";
--> statement-breakpoint
ALTER TABLE "items" DROP CONSTRAINT "items_id_library_unique";
--> statement-breakpoint
DROP INDEX "items_library_added_idx";--> statement-breakpoint
DROP INDEX "items_folder_idx";--> statement-breakpoint
ALTER TABLE "item_folders" ADD CONSTRAINT "item_folders_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_folders" ADD CONSTRAINT "item_folders_root_id_library_roots_id_fk" FOREIGN KEY ("root_id") REFERENCES "public"."library_roots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" DROP COLUMN "library_id";--> statement-breakpoint
ALTER TABLE "items" DROP COLUMN "canonical_folder";--> statement-breakpoint
ALTER TABLE "items" DROP COLUMN "title_key";
