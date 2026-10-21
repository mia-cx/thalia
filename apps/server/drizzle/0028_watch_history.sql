CREATE TABLE "plays" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"play_method" "play_method" NOT NULL,
	"transcode_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"played_seconds" double precision NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plays_session_id_unique" UNIQUE("session_id"),
	CONSTRAINT "plays_played_check" CHECK ("plays"."played_seconds" >= 0 and "plays"."played_seconds" < 'Infinity'::float8)
);
--> statement-breakpoint
ALTER TABLE "session_registry" ADD COLUMN "played_seconds" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "session_registry" ADD COLUMN "reported_position" double precision;--> statement-breakpoint
ALTER TABLE "session_registry" ADD COLUMN "reported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "plays" ADD CONSTRAINT "plays_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plays" ADD CONSTRAINT "plays_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plays_user_started_idx" ON "plays" USING btree ("user_id","started_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "plays_started_idx" ON "plays" USING btree ("started_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "session_registry" ADD CONSTRAINT "session_registry_played_check" CHECK ("session_registry"."played_seconds" >= 0 and "session_registry"."played_seconds" < 'Infinity'::float8);