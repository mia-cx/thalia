import { and, desc, eq, gte, type SQLWrapper, sql } from "drizzle-orm";
import { Schema } from "effect";
import { browseCardsById } from "../api/items.ts";
import {
  decodeCursor,
  defaultPageSize,
  type PageKey,
  toPage,
} from "../api/pagination.ts";
import { transcodeReasons } from "../api/playback-sessions.ts";
import { type WatchThreshold, WatchThresholds } from "../api/schema.ts";
import { server } from "../auth/access.ts";
import { AuthError } from "../auth/errors.ts";
import { requirePermission, viewableLibraryIds } from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import {
  itemAncestors,
  items,
  libraries,
  plays,
  sessionRegistry,
  settings,
  users,
} from "../db/schema/index.ts";
import { inLibraries } from "../libraries/membership.ts";

type Tx = Pick<Database, "select" | "insert" | "update">;

const thresholdsKey = "watch-history";
const defaultThreshold: WatchThreshold = { unit: "minutes", value: 2 };

/** Reads each medium's threshold; a medium never set uses two minutes. */
export async function readWatchThresholds(
  db: Pick<Database, "select">,
): Promise<WatchThresholds> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, thresholdsKey))
    .limit(1);
  const stored = row?.value;
  return Schema.decodeUnknownSync(WatchThresholds)({
    movies: defaultThreshold,
    shows: defaultThreshold,
    ...(typeof stored === "object" && !Array.isArray(stored) ? stored : {}),
  });
}

/** Sets the thresholds of the given mediums for a caller holding server:manage. */
export async function writeWatchThresholds(
  db: Database,
  actorId: string,
  patch: Partial<WatchThresholds>,
) {
  await requirePermission(db, actorId, "server:manage", server);
  await db
    .insert(settings)
    .values({ key: thresholdsKey, value: patch })
    .onConflictDoUpdate({
      target: settings.key,
      set: {
        value: sql`${settings.value} || ${JSON.stringify(patch)}::text::jsonb`,
        updatedAt: sql`clock_timestamp()`,
      },
    });
}

/**
 * Records a session in the watch history once it passes its medium's
 * threshold, or once it plays to where the Item counts as watched, then
 * keeps its played time current. A percentage of an unknown runtime never
 * passes. The session id is unique, so a repeated report never adds a play.
 */
export async function recordPlay(
  tx: Tx,
  session: { id: string; userId: string; itemId: string },
  version: { libraryId: string; durationSeconds: number | null },
  finished: boolean,
) {
  const [row] = await tx
    .select({
      playedSeconds: sessionRegistry.playedSeconds,
      playMethod: sessionRegistry.playMethod,
      decision: sessionRegistry.decision,
      createdAt: sessionRegistry.createdAt,
      medium: libraries.medium,
    })
    .from(sessionRegistry)
    .innerJoin(libraries, eq(libraries.id, version.libraryId))
    .where(eq(sessionRegistry.id, session.id))
    .limit(1);
  if (row === undefined) return;
  const threshold = (await readWatchThresholds(tx))[row.medium];
  const neededSeconds =
    threshold.unit === "minutes"
      ? threshold.value * 60
      : version.durationSeconds === null
        ? Number.POSITIVE_INFINITY
        : (threshold.value / 100) * version.durationSeconds;
  const current = {
    playMethod: row.playMethod,
    transcodeReasons: transcodeReasons(row.decision),
    playedSeconds: row.playedSeconds,
    updatedAt: sql`clock_timestamp()`,
  };
  if ((finished && row.playedSeconds > 0) || row.playedSeconds >= neededSeconds)
    await tx
      .insert(plays)
      .values({
        ...current,
        userId: session.userId,
        itemId: session.itemId,
        sessionId: session.id,
        startedAt: row.createdAt,
      })
      .onConflictDoUpdate({ target: plays.sessionId, set: current });
  else
    await tx.update(plays).set(current).where(eq(plays.sessionId, session.id));
}

const cursorPrefix = "h1.";
const instantText = (column: SQLWrapper) =>
  sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Lists watch history newest first: the caller's own, or with `everyone`
 * every user's, which needs server:manage. Items the caller can no longer
 * view drop out.
 */
export async function listHistory(
  db: Database,
  actorId: string,
  input: { everyone?: boolean; limit?: number; cursor?: string },
) {
  if (input.everyone)
    await requirePermission(db, actorId, "server:manage", server);
  const limit = input.limit ?? defaultPageSize;
  let key: PageKey | undefined;
  if (input.cursor !== undefined) {
    if (!input.cursor.startsWith(cursorPrefix))
      throw new AuthError("INVALID_INPUT");
    key = decodeCursor(input.cursor.slice(cursorPrefix.length));
    if (key === undefined) throw new AuthError("INVALID_INPUT");
  }
  const viewable = await viewableLibraryIds(db, actorId);
  const rows = await db
    .select({
      id: plays.id,
      itemId: plays.itemId,
      user: { id: users.id, displayName: users.displayName },
      playMethod: plays.playMethod,
      playedSeconds: plays.playedSeconds,
      startedAt: instantText(plays.startedAt),
    })
    .from(plays)
    .innerJoin(users, eq(users.id, plays.userId))
    .where(
      and(
        input.everyone ? undefined : eq(plays.userId, actorId),
        inLibraries(viewable, plays.itemId),
        key === undefined
          ? undefined
          : sql`(${plays.startedAt}, ${plays.id}) < (${key.addedAt}::timestamptz, ${key.id}::uuid)`,
      ),
    )
    .orderBy(desc(plays.startedAt), desc(plays.id))
    .limit(limit + 1);
  const page = toPage(rows, limit, (row) => ({
    addedAt: row.startedAt,
    id: row.id,
  }));
  const cards = new Map(
    (
      await browseCardsById(db, [
        ...new Set(page.items.map((row) => row.itemId)),
      ])
    ).map((card) => [card.id, card]),
  );
  return {
    items: page.items.flatMap(({ itemId, ...row }) => {
      const item = cards.get(itemId);
      return item === undefined ? [] : [{ ...row, item }];
    }),
    cursor: page.cursor === null ? null : `${cursorPrefix}${page.cursor}`,
  };
}

/** Weeks the watch-time chart covers; the top lists cover the same span. */
export const insightWeeks = 12;
const topCount = 5;

/**
 * The Overview's view of the history over the last `insightWeeks` weeks:
 * watch time per week (Monday starts, UTC, oldest first, empty weeks
 * included), the most played titles with Episodes counted toward their Show,
 * the users who watched longest, and the time each play method took.
 */
export async function historyInsights(db: Database, actorId: string) {
  await requirePermission(db, actorId, "server:manage", server);
  const week = sql`date_trunc('week', ${plays.startedAt} at time zone 'UTC')`;
  const since = sql`date_trunc('week', clock_timestamp() at time zone 'UTC') - ${insightWeeks - 1} * interval '1 week'`;
  const inSpan = gte(sql`${plays.startedAt} at time zone 'UTC'`, since);
  const weekRows = await db
    .select({
      start: sql<string>`to_char(series.week, 'YYYY-MM-DD')`,
      seconds: sql<number>`coalesce(sum(${plays.playedSeconds}), 0)::float8`,
    })
    .from(
      sql`generate_series(${since}, date_trunc('week', clock_timestamp() at time zone 'UTC'), interval '1 week') as series(week)`,
    )
    .leftJoin(plays, sql`${week} = series.week`)
    .groupBy(sql`series.week`)
    .orderBy(sql`series.week`);
  const title = db
    .select({
      itemId: sql<string>`${itemAncestors.ancestorId}`.as("title_id"),
      playedSeconds: plays.playedSeconds,
    })
    .from(plays)
    .innerJoin(itemAncestors, eq(itemAncestors.descendantId, plays.itemId))
    .innerJoin(items, eq(items.id, itemAncestors.ancestorId))
    .where(and(inSpan, sql`${items.parentId} is null`))
    .as("title");
  const titleRows = await db
    .select({
      itemId: title.itemId,
      plays: sql<number>`count(*)::int`,
      seconds: sql<number>`sum(${title.playedSeconds})::float8`,
    })
    .from(title)
    .groupBy(title.itemId)
    .orderBy(sql`count(*) desc`, sql`sum(${title.playedSeconds}) desc`)
    .limit(topCount);
  const topUsers = await db
    .select({
      user: { id: users.id, displayName: users.displayName },
      plays: sql<number>`count(*)::int`,
      seconds: sql<number>`sum(${plays.playedSeconds})::float8`,
    })
    .from(plays)
    .innerJoin(users, eq(users.id, plays.userId))
    .where(inSpan)
    .groupBy(users.id)
    .orderBy(sql`sum(${plays.playedSeconds}) desc`, users.id)
    .limit(topCount);
  const methodRows = await db
    .select({
      playMethod: plays.playMethod,
      seconds: sql<number>`sum(${plays.playedSeconds})::float8`,
    })
    .from(plays)
    .where(inSpan)
    .groupBy(plays.playMethod);
  const cards = new Map(
    (
      await browseCardsById(
        db,
        titleRows.map((row) => row.itemId),
      )
    ).map((card) => [card.id, card]),
  );
  const methodSeconds = (method: (typeof methodRows)[number]["playMethod"]) =>
    methodRows.find((row) => row.playMethod === method)?.seconds ?? 0;
  return {
    weeks: weekRows,
    topTitles: titleRows.flatMap(({ itemId, ...row }) => {
      const item = cards.get(itemId);
      return item === undefined ? [] : [{ ...row, item }];
    }),
    topUsers,
    methods: {
      directPlay: methodSeconds("direct-play"),
      remux: methodSeconds("remux"),
      transcode: methodSeconds("transcode"),
    },
  };
}
