import { and, asc, desc, eq, ne, or, sql } from "drizzle-orm";
import { Schema } from "effect";
import { publishEvent } from "../api/events.ts";
import { AuthError } from "../auth/errors.ts";
import {
  permittedVersionIds,
  requirePermission,
  requireVersionPermission,
} from "../auth/permissions.ts";
import type { authenticate } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import {
  items,
  progress,
  sessionRegistry,
  versions,
} from "../db/schema/index.ts";
import { emitPluginEvents } from "../plugins/events.ts";
import { recordPlay } from "./history.ts";
import { callerClient } from "./planning.ts";

type Caller = Awaited<ReturnType<typeof authenticate>>;
type ProgressDb = Pick<Database, "select">;
type LifecycleDb = Pick<
  Database,
  "select" | "insert" | "update" | "execute" | "transaction"
>;
type Scope = { sessionId: string; itemId: string };
type ProgressRow = typeof progress.$inferSelect;
type VersionRow = typeof versions.$inferSelect;

function toProgress(row: ProgressRow) {
  return {
    userId: row.userId,
    itemId: row.itemId,
    versionId: row.versionId,
    format: row.format,
    positionSeconds: row.positionSeconds,
    completed: row.completed,
    playedAt: row.playedAt === null ? null : row.playedAt.toISOString(),
    playCount: row.playCount,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function readProgressRow(db: ProgressDb, userId: string, itemId: string) {
  const [row] = await db
    .select()
    .from(progress)
    .where(and(eq(progress.userId, userId), eq(progress.itemId, itemId)))
    .limit(1);
  return row;
}

async function readProgress(db: ProgressDb, userId: string, itemId: string) {
  const row = await readProgressRow(db, userId, itemId);
  if (row === undefined) return null;
  if (row.versionId === null) return toProgress(row);
  const candidates = await db
    .select({
      id: versions.id,
      itemId: versions.itemId,
      libraryId: versions.libraryId,
    })
    .from(versions)
    .where(eq(versions.id, row.versionId));
  const visible = await permittedVersionIds(db, userId, "view", candidates);
  return toProgress({
    ...row,
    versionId: visible.has(row.versionId) ? row.versionId : null,
  });
}

async function requireViewableItem(
  db: ProgressDb,
  userId: string,
  itemId: string,
) {
  const [item] = await db
    .select({ id: items.id })
    .from(items)
    .where(eq(items.id, itemId))
    .limit(1);
  if (item === undefined) throw new AuthError("NOT_FOUND");
  await requirePermission(db, userId, "view", {
    type: "item",
    id: itemId,
  });
  return item;
}

function clampPosition(position: number, durationSeconds: number | null) {
  return durationSeconds === null
    ? position
    : Math.min(position, durationSeconds);
}

async function resumePosition(
  db: ProgressDb,
  userId: string,
  itemId: string,
  target: VersionRow,
): Promise<number> {
  const row = await readProgressRow(db, userId, itemId);
  if (
    row === undefined ||
    row.completed ||
    row.versionId === null ||
    row.format !== target.format
  )
    return 0;
  if (row.versionId === target.id)
    return clampPosition(row.positionSeconds, target.durationSeconds);
  const [source] = await db
    .select()
    .from(versions)
    .where(and(eq(versions.id, row.versionId), eq(versions.itemId, itemId)))
    .limit(1);
  if (
    source === undefined ||
    source.format !== target.format ||
    target.segmentTimelineId === null ||
    source.segmentTimelineId !== target.segmentTimelineId
  )
    return 0;
  return clampPosition(row.positionSeconds, target.durationSeconds);
}

/** Reads the caller's stored progress for an Item, or null when unwatched. */
export async function getProgress(
  db: ProgressDb,
  userId: string,
  itemId: string,
) {
  await requireViewableItem(db, userId, itemId);
  return readProgress(db, userId, itemId);
}

/** Computes the resume position for a Version from stored compatible progress. */
export async function resumeProgress(
  db: ProgressDb,
  userId: string,
  itemId: string,
  versionId: string,
) {
  await requireViewableItem(db, userId, itemId);
  await requirePermission(db, userId, "play", {
    type: "item",
    id: itemId,
  });
  const [version] = await db
    .select()
    .from(versions)
    .where(and(eq(versions.id, versionId), eq(versions.itemId, itemId)))
    .limit(1);
  if (version === undefined) throw new AuthError("NOT_FOUND");
  await requireVersionPermission(db, userId, "play", version.id, itemId);
  return {
    positionSeconds: await resumePosition(db, userId, itemId, version),
  };
}

function checkScope(scope: Scope) {
  if (
    !Schema.is(Schema.UUID)(scope.sessionId) ||
    !Schema.is(Schema.UUID)(scope.itemId)
  )
    throw new AuthError("UNAUTHENTICATED");
}

function checkPosition(position: number, durationSeconds: number | null) {
  if (!Number.isFinite(position) || position < 0)
    throw new AuthError("INVALID_INPUT");
  if (durationSeconds !== null && position > durationSeconds)
    throw new AuthError("INVALID_INPUT");
}

async function lockSession(tx: LifecycleDb, userId: string, scope: Scope) {
  const [session] = await tx
    .select({
      userId: sessionRegistry.userId,
      versionId: sessionRegistry.versionId,
      state: sessionRegistry.state,
    })
    .from(sessionRegistry)
    .where(
      and(
        eq(sessionRegistry.id, scope.sessionId),
        eq(sessionRegistry.itemId, scope.itemId),
      ),
    )
    .for("update")
    .limit(1);
  if (session === undefined || session.userId !== userId)
    throw new AuthError("UNAUTHENTICATED");
  const [version] = await tx
    .select()
    .from(versions)
    .where(
      and(
        eq(versions.id, session.versionId),
        eq(versions.itemId, scope.itemId),
      ),
    )
    .limit(1);
  if (version === undefined) throw new AuthError("NOT_FOUND");
  await requireVersionPermission(tx, userId, "play", version.id, scope.itemId);
  await requirePermission(tx, userId, "view", {
    type: "item",
    id: version.itemId,
  });
  await requirePermission(tx, userId, "play", {
    type: "item",
    id: version.itemId,
  });
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${userId}:${scope.itemId}`}, 0))`,
  );
  return { session, version };
}

/** Jellyfin's MaxResumePct: a position past this share of a Version counts as watched. */
const watchedThreshold = 0.9;

async function upsertProgress(
  tx: LifecycleDb,
  userId: string,
  itemId: string,
  version: VersionRow,
  positionSeconds: number,
  completed: boolean,
  countPlay: boolean,
) {
  const watched =
    completed ||
    (version.durationSeconds !== null &&
      positionSeconds >= watchedThreshold * version.durationSeconds);
  await tx
    .insert(progress)
    .values({
      userId,
      itemId,
      versionId: version.id,
      format: version.format,
      positionSeconds,
      completed: watched,
      playedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
      playCount: countPlay ? 1 : 0,
    })
    .onConflictDoUpdate({
      target: [progress.userId, progress.itemId],
      set: {
        versionId: version.id,
        format: version.format,
        positionSeconds,
        completed: watched,
        playedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
        ...(countPlay ? { playCount: sql`${progress.playCount} + 1` } : {}),
      },
    });
  await emitPluginEvents(tx, [
    {
      event: "progress.updated",
      payload: { itemId, userId, positionSeconds, completed },
    },
  ]);
  return watched;
}

/**
 * Adds the playback since the session's last report: how far the position
 * moved, capped by the time between the reports, so a seek or a pause adds
 * nothing that didn't play. The first report only sets the baseline.
 */
async function addPlayed(
  tx: LifecycleDb,
  sessionId: string,
  positionSeconds: number,
) {
  await tx
    .update(sessionRegistry)
    .set({
      playedSeconds: sql`${sessionRegistry.playedSeconds} + coalesce(greatest(0, least(
        ${positionSeconds}::float8 - ${sessionRegistry.reportedPosition},
        extract(epoch from clock_timestamp() - ${sessionRegistry.reportedAt})
      )), 0)`,
      reportedPosition: positionSeconds,
      reportedAt: sql`clock_timestamp()`,
    })
    .where(eq(sessionRegistry.id, sessionId));
}

/** Counts a report toward the session's played time and its watch history. */
async function reportPlayed(
  tx: LifecycleDb,
  userId: string,
  scope: Scope,
  version: VersionRow,
  positionSeconds: number,
  watched: boolean,
) {
  await addPlayed(tx, scope.sessionId, positionSeconds);
  await recordPlay(
    tx,
    { id: scope.sessionId, userId, itemId: scope.itemId },
    version,
    watched,
  );
}

async function touchSession(tx: LifecycleDb, sessionId: string) {
  await tx
    .update(sessionRegistry)
    .set({ lastSeenAt: sql`clock_timestamp()` })
    .where(eq(sessionRegistry.id, sessionId));
}

/**
 * Finds the play session a client reports against, for clients that play
 * without asking Thalia to plan. The named session wins when it is the
 * caller's and on this Item, in any state, so a repeated or late report
 * changes only its own play. A client may name a session Thalia never
 * issued, or none, so next comes the newest live session the same device
 * opened on the Item and Version; else a new direct-play session on the
 * named Version, or the Item's first.
 */
export async function resolvePlaySession(
  db: Database,
  caller: Caller,
  report: { itemId: string; sessionId?: string; versionId?: string },
) {
  const { itemId, sessionId, versionId } = report;
  const userId = caller.user.id;
  const credentialId = caller.credential.id;
  await requireViewableItem(db, userId, itemId);
  await requirePermission(db, userId, "play", {
    type: "item",
    id: itemId,
  });
  const [found] = await db
    .select({
      id: sessionRegistry.id,
      versionId: sessionRegistry.versionId,
      state: sessionRegistry.state,
    })
    .from(sessionRegistry)
    .where(
      and(
        eq(sessionRegistry.userId, userId),
        eq(sessionRegistry.itemId, itemId),
        or(
          sessionId === undefined
            ? undefined
            : eq(sessionRegistry.id, sessionId),
          and(
            ne(sessionRegistry.state, "stopped"),
            eq(sessionRegistry.credentialId, credentialId),
            versionId === undefined
              ? undefined
              : eq(sessionRegistry.versionId, versionId),
          ),
        ),
      ),
    )
    .orderBy(
      sql`${sessionRegistry.id} = ${sessionId ?? null} desc nulls last`,
      desc(sessionRegistry.createdAt),
      desc(sessionRegistry.id),
    )
    .limit(1);
  if (versionId !== undefined)
    await requireVersionPermission(db, userId, "play", versionId, itemId);
  if (found !== undefined)
    await requireVersionPermission(db, userId, "play", found.versionId, itemId);
  const candidates = await db
    .select({
      id: versions.id,
      itemId: versions.itemId,
      libraryId: versions.libraryId,
      durationSeconds: versions.durationSeconds,
    })
    .from(versions)
    .where(
      and(
        eq(versions.itemId, itemId),
        eq(versions.origin, "imported"),
        found !== undefined
          ? eq(versions.id, found.versionId)
          : versionId === undefined
            ? undefined
            : eq(versions.id, versionId),
      ),
    )
    .orderBy(asc(versions.label), asc(versions.id));
  const allowed = await permittedVersionIds(db, userId, "play", candidates);
  const version = candidates.find((version) => allowed.has(version.id));
  if (version === undefined) throw new AuthError("NOT_FOUND");
  const { durationSeconds } = version;
  if (found !== undefined)
    return { sessionId: found.id, state: found.state, durationSeconds };
  const client = await callerClient(db, caller);
  const opened = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(sessionRegistry)
      .values({
        userId,
        itemId,
        versionId: version.id,
        playMethod: "direct-play",
        state: "starting",
        ...client,
        credentialId,
      })
      .returning({ id: sessionRegistry.id, state: sessionRegistry.state });
    if (row === undefined) throw new Error("Session insert returned no row.");
    await publishEvent(tx, {
      kind: "session.state",
      sessionId: row.id,
      state: "starting",
    });
    return row;
  });
  return { sessionId: opened.id, state: opened.state, durationSeconds };
}

/** Marks a planned session playing and records its first position. */
export async function startPlayback(
  db: Database,
  userId: string,
  scope: Scope,
  positionSeconds?: number,
) {
  checkScope(scope);
  return db.transaction(async (tx) => {
    const { session, version } = await lockSession(tx, userId, scope);
    if (session.state === "playing")
      return {
        state: "playing" as const,
        progress: await readProgress(tx, userId, scope.itemId),
      };
    if (session.state !== "starting") throw new AuthError("CONFLICT");
    const position =
      positionSeconds ??
      (await resumePosition(tx, userId, scope.itemId, version));
    checkPosition(position, version.durationSeconds);
    await upsertProgress(
      tx,
      userId,
      scope.itemId,
      version,
      position,
      false,
      true,
    );
    await addPlayed(tx, scope.sessionId, position);
    await tx
      .update(sessionRegistry)
      .set({ state: "playing", lastSeenAt: sql`clock_timestamp()` })
      .where(eq(sessionRegistry.id, scope.sessionId));
    await publishEvent(tx, {
      kind: "session.state",
      sessionId: scope.sessionId,
      state: "playing",
    });
    await emitPluginEvents(tx, [
      {
        event: "playback.started",
        payload: { itemId: scope.itemId, userId, sessionId: scope.sessionId },
      },
    ]);
    return {
      state: "playing" as const,
      progress: await readProgress(tx, userId, scope.itemId),
    };
  });
}

/** Records a position heartbeat for a playing session. */
export async function updatePlayback(
  db: Database,
  userId: string,
  scope: Scope,
  input: { positionSeconds: number; completed?: boolean },
) {
  checkScope(scope);
  return db.transaction(async (tx) => {
    const { session, version } = await lockSession(tx, userId, scope);
    if (session.state !== "playing") throw new AuthError("CONFLICT");
    checkPosition(input.positionSeconds, version.durationSeconds);
    const watched = await upsertProgress(
      tx,
      userId,
      scope.itemId,
      version,
      input.positionSeconds,
      input.completed ?? false,
      false,
    );
    await reportPlayed(
      tx,
      userId,
      scope,
      version,
      input.positionSeconds,
      watched,
    );
    await touchSession(tx, scope.sessionId);
    return {
      state: "playing" as const,
      progress: await readProgress(tx, userId, scope.itemId),
    };
  });
}

/** Stops a session, persisting the final position when it was playing and one is given; a queued or starting session stops without one. */
export async function stopPlayback(
  db: Database,
  userId: string,
  scope: Scope,
  input: { positionSeconds?: number; completed?: boolean },
) {
  checkScope(scope);
  return db.transaction(async (tx) => {
    const { session, version } = await lockSession(tx, userId, scope);
    if (session.state === "stopped")
      return {
        state: "stopped" as const,
        progress: await readProgress(tx, userId, scope.itemId),
      };
    if (session.state === "playing" && input.positionSeconds !== undefined) {
      checkPosition(input.positionSeconds, version.durationSeconds);
      const watched = await upsertProgress(
        tx,
        userId,
        scope.itemId,
        version,
        input.positionSeconds,
        input.completed ?? false,
        false,
      );
      await reportPlayed(
        tx,
        userId,
        scope,
        version,
        input.positionSeconds,
        watched,
      );
      await publishEvent(tx, {
        kind: "user-data.changed",
        userId,
        itemIds: [scope.itemId],
      });
    }
    await tx
      .update(sessionRegistry)
      .set({ state: "stopped", lastSeenAt: sql`clock_timestamp()` })
      .where(eq(sessionRegistry.id, scope.sessionId));
    await publishEvent(tx, {
      kind: "session.state",
      sessionId: scope.sessionId,
      state: "stopped",
    });
    await emitPluginEvents(tx, [
      {
        event: "playback.stopped",
        payload: { itemId: scope.itemId, userId, sessionId: scope.sessionId },
      },
    ]);
    return {
      state: "stopped" as const,
      progress: await readProgress(tx, userId, scope.itemId),
    };
  });
}
