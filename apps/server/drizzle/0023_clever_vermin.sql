CREATE TABLE "access_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"group_id" uuid,
	"library_id" uuid,
	"item_id" uuid,
	"action" text NOT NULL,
	"allowed" boolean NOT NULL,
	CONSTRAINT "access_rules_unique" UNIQUE NULLS NOT DISTINCT("user_id","group_id","library_id","item_id","action"),
	CONSTRAINT "access_rules_subject_check" CHECK (num_nonnulls("access_rules"."user_id", "access_rules"."group_id") = 1),
	CONSTRAINT "access_rules_object_check" CHECK (num_nonnulls("access_rules"."library_id", "access_rules"."item_id") <= 1),
	CONSTRAINT "access_rules_action_check" CHECK ("access_rules"."action" = ANY(ARRAY['view','play','download','metadata:edit','subtitles:edit','libraries:manage','users:manage','plugins:manage','transcoding:manage','server:manage']::text[])),
	CONSTRAINT "access_rules_server_action_check" CHECK (not ("access_rules"."action" = ANY(ARRAY['libraries:manage','users:manage','plugins:manage','transcoding:manage','server:manage']::text[])) or ("access_rules"."library_id" is null and "access_rules"."item_id" is null))
);
--> statement-breakpoint
ALTER TABLE "library_access" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_permission_overrides" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Preserve subjects, objects and explicit denials before removing the old slots.
INSERT INTO "access_rules" ("id", "group_id", "action", "allowed")
SELECT gen_random_uuid(), g.id,
  CASE p WHEN 'manage-metadata' THEN 'metadata:edit' WHEN 'manage-subtitles' THEN 'subtitles:edit'
    ELSE CASE WHEN p LIKE 'manage-%' THEN substring(p from 8) || ':manage' ELSE p END END,
  true FROM groups g CROSS JOIN LATERAL unnest(g.permissions) p
ON CONFLICT ON CONSTRAINT "access_rules_unique" DO NOTHING;
--> statement-breakpoint
INSERT INTO "access_rules" ("id", "user_id", "action", "allowed")
SELECT id, user_id,
  CASE permission WHEN 'manage-metadata' THEN 'metadata:edit' WHEN 'manage-subtitles' THEN 'subtitles:edit'
    ELSE CASE WHEN permission LIKE 'manage-%' THEN substring(permission from 8) || ':manage' ELSE permission END END,
  allowed FROM user_permission_overrides;
--> statement-breakpoint
INSERT INTO "access_rules" ("id", "user_id", "group_id", "library_id", "action", "allowed")
SELECT id, user_id, group_id, library_id, 'view', allowed FROM library_access;
--> statement-breakpoint
DROP TABLE "library_access" CASCADE;--> statement-breakpoint
DROP TABLE "user_permission_overrides" CASCADE;--> statement-breakpoint
ALTER TABLE "groups" DROP CONSTRAINT "groups_permissions_check";--> statement-breakpoint
ALTER TABLE "access_rules" ADD CONSTRAINT "access_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_rules" ADD CONSTRAINT "access_rules_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_rules" ADD CONSTRAINT "access_rules_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_rules" ADD CONSTRAINT "access_rules_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_rules_group_idx" ON "access_rules" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "access_rules_library_idx" ON "access_rules" USING btree ("library_id");--> statement-breakpoint
CREATE INDEX "access_rules_item_idx" ON "access_rules" USING btree ("item_id");--> statement-breakpoint
ALTER TABLE "groups" DROP COLUMN "permissions";
