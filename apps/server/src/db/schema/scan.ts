import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { ProbeResult } from "../../mediums/video-common/probe.ts";
import { id, instant, jsonb, owned } from "./common.ts";
import { libraries, libraryRoots } from "./core.ts";

/** Why a scan skipped a file: ffprobe couldn't read it, or it holds no video stream. */
export const scanFailureReason = pgEnum("scan_failure_reason", [
  "unreadable",
  "no-video",
]);

/**
 * Files a scan skipped, keyed by root and root-relative path. The size and
 * mtime are the file's when it failed: a rescan probes it again only once
 * they change. A successful index of the path deletes the row.
 */
export const scanFailures = pgTable(
  "scan_failures",
  {
    id: id(),
    rootId: uuid("root_id")
      .notNull()
      .references(() => libraryRoots.id, owned),
    path: text("path").notNull(),
    bytes: bigint("bytes", { mode: "bigint" }).notNull(),
    modifiedNs: bigint("modified_ns", { mode: "bigint" }).notNull(),
    reason: scanFailureReason("reason").notNull(),
    /** The full error text, such as ffprobe's stderr. */
    detail: text("detail").notNull(),
    failedAt: instant("failed_at").notNull().defaultNow(),
  },
  (table) => [
    unique("scan_failures_root_path_unique").on(table.rootId, table.path),
    check("scan_failures_bytes_check", sql`${table.bytes} >= 0`),
  ],
);

/** Cached ffprobe results keyed by root and root-relative path. */
export const probeCache = pgTable(
  "probe_cache",
  {
    id: id(),
    rootId: uuid("root_id")
      .notNull()
      .references(() => libraryRoots.id, owned),
    path: text("path").notNull(),
    bytes: bigint("bytes", { mode: "bigint" }).notNull(),
    modifiedNs: bigint("modified_ns", { mode: "bigint" }).notNull(),
    result: jsonb("result").$type<ProbeResult>().notNull(),
  },
  (table) => [
    unique("probe_cache_root_path_unique").on(table.rootId, table.path),
    check("probe_cache_bytes_check", sql`${table.bytes} >= 0`),
  ],
);

export const scanRunState = pgEnum("scan_run_state", [
  "running",
  "completed",
  "failed",
  "interrupted",
]);

/**
 * One whole-Library scan, keyed by the job that fanned it out. It counts as
 * its folder jobs settle, and once none is left it stays as the Library's
 * last-scan summary.
 */
export const scanRuns = pgTable(
  "scan_runs",
  {
    id: uuid("id").primaryKey(),
    libraryId: uuid("library_id")
      .notNull()
      .references(() => libraries.id, owned),
    state: scanRunState("state").notNull().default("running"),
    /** Media files the fan-out found, and those the settled folders checked. */
    total: integer("total").notNull().default(0),
    checked: integer("checked").notNull().default(0),
    added: integer("added").notNull().default(0),
    changed: integer("changed").notNull().default(0),
    removed: integer("removed").notNull().default(0),
    /** Files the scan found but couldn't read as video. */
    unreadable: integer("unreadable").notNull().default(0),
    /** Each unsettled folder job's id, mapped to the files the fan-out found in its folder. */
    pending: jsonb("pending")
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    currentFolder: text("current_folder"),
    error: text("error"),
    startedAt: instant("started_at").notNull().defaultNow(),
    finishedAt: instant("finished_at"),
    /** The last time an update went out as an event; updates closer together stay quiet. */
    publishedAt: instant("published_at").notNull().defaultNow(),
  },
  (table) => [
    index("scan_runs_library_started_idx").on(
      table.libraryId,
      table.startedAt.desc(),
    ),
  ],
);
