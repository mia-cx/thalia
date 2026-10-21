CREATE TABLE "jellyfin_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"item_id" uuid NOT NULL,
	"library_id" uuid NOT NULL,
	CONSTRAINT "jellyfin_items_pair_unique" UNIQUE("item_id","library_id")
);
--> statement-breakpoint
ALTER TABLE "jellyfin_items" ADD CONSTRAINT "jellyfin_items_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jellyfin_items" ADD CONSTRAINT "jellyfin_items_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jellyfin_items_library_idx" ON "jellyfin_items" USING btree ("library_id");