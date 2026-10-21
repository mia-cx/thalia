CREATE TYPE "public"."scan_run_state" AS ENUM('running', 'completed', 'failed', 'interrupted');--> statement-breakpoint
CREATE TABLE "scan_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"library_id" uuid NOT NULL,
	"state" "scan_run_state" DEFAULT 'running' NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"checked" integer DEFAULT 0 NOT NULL,
	"added" integer DEFAULT 0 NOT NULL,
	"changed" integer DEFAULT 0 NOT NULL,
	"removed" integer DEFAULT 0 NOT NULL,
	"unreadable" integer DEFAULT 0 NOT NULL,
	"pending" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"current_folder" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scan_runs" ADD CONSTRAINT "scan_runs_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scan_runs_library_started_idx" ON "scan_runs" USING btree ("library_id","started_at" DESC NULLS LAST);