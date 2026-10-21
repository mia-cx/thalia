import { describe, expect, test } from "bun:test";
import { ORPCError } from "@orpc/client";
import { eq, sql } from "drizzle-orm";
import { createThaliaClient } from "../../../web/src/lib/api.ts";
import { AuthError } from "../auth/errors.ts";
import { login } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { plays, sessionRegistry, versions } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startThalia } from "../index.ts";
import { createJellyfinHandler } from "../jellyfin/http.ts";
import { toGuid } from "../jellyfin/request.ts";
import { jellyfinRoutes } from "../jellyfin/routes.ts";
import { jellyfinLogin } from "../jellyfin/testing.ts";
import { createArtworkHandler } from "../metadata/artwork-http.ts";
import { historyInsights, listHistory } from "../playback/history.ts";
import {
  startPlayback,
  stopPlayback,
  updatePlayback,
} from "../playback/progress.ts";
import { createHlsHandler } from "./hls.ts";
import { seedBrowse } from "./view-fixtures.ts";

const device = { clientName: "Test", deviceId: "d1", deviceName: "Desk" };

async function openSession(
  db: Database,
  userId: string,
  itemId: string,
  playMethod: "direct-play" | "transcode" = "direct-play",
) {
  const [version] = await db
    .select()
    .from(versions)
    .where(eq(versions.itemId, itemId))
    .limit(1);
  if (!version) throw new Error("No Version.");
  const [session] = await db
    .insert(sessionRegistry)
    .values({
      userId,
      itemId,
      versionId: version.id,
      playMethod,
      state: "starting",
    })
    .returning();
  if (!session) throw new Error("Session insert returned no row.");
  return { sessionId: session.id, itemId };
}

/** Moves a session's last report back in time, as if the player had played that long since. */
async function elapse(db: Database, sessionId: string, seconds: number) {
  await db
    .update(sessionRegistry)
    .set({
      reportedAt: sql`${sessionRegistry.reportedAt} - ${seconds} * interval '1 second'`,
    })
    .where(eq(sessionRegistry.id, sessionId));
}

describe.skipIf(!databaseUrl)("watch history", () => {
  test("a web play is recorded once it passes two minutes, once per session", () =>
    withDatabase(async (db) => {
      const s = await seedBrowse(db);
      const scope = await openSession(db, s.viewer.id, s.matrix.id);
      await startPlayback(db, s.viewer.id, scope, 0);
      await elapse(db, scope.sessionId, 60);
      await updatePlayback(db, s.viewer.id, scope, { positionSeconds: 60 });
      expect(await db.select().from(plays)).toEqual([]);

      // A seek forward adds only the time that passed, not the distance.
      await elapse(db, scope.sessionId, 30);
      await updatePlayback(db, s.viewer.id, scope, { positionSeconds: 3000 });
      expect(await db.select().from(plays)).toEqual([]);

      await elapse(db, scope.sessionId, 40);
      await updatePlayback(db, s.viewer.id, scope, { positionSeconds: 3040 });
      await elapse(db, scope.sessionId, 20);
      await stopPlayback(db, s.viewer.id, scope, { positionSeconds: 3060 });
      await stopPlayback(db, s.viewer.id, scope, { positionSeconds: 3060 });
      const recorded = await db.select().from(plays);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        userId: s.viewer.id,
        itemId: s.matrix.id,
        sessionId: scope.sessionId,
        playMethod: "direct-play",
      });
      expect(recorded[0]?.playedSeconds).toBeCloseTo(150, 0);
    }));

  test("a Jellyfin client's play is recorded through the same rule", () =>
    withDatabase(async (db) => {
      const s = await seedBrowse(db);
      const header =
        'MediaBrowser Client="Findroid", Version="1", Device="Pixel", DeviceId="f1"';
      const send = async (request: Request) => {
        const response = await createJellyfinHandler(
          db,
          jellyfinRoutes(createArtworkHandler(db), createHlsHandler(db)),
        )(request, "127.0.0.1");
        if (response === undefined) throw new Error("Unrouted.");
        return response;
      };
      const token = await jellyfinLogin(send, header);
      const report = (path: string, seconds: number) =>
        send(
          new Request(`http://thalia.test/Sessions/Playing${path}`, {
            method: "POST",
            headers: {
              authorization: `${header}, Token="${token}"`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              ItemId: toGuid(s.matrix.id),
              PositionTicks: seconds * 10_000_000,
            }),
          }),
        );
      expect((await report("", 0)).status).toBe(204);
      const [session] = await db.select().from(sessionRegistry);
      if (!session) throw new Error("No session.");
      await elapse(db, session.id, 200);
      expect((await report("/Progress", 200)).status).toBe(204);
      await elapse(db, session.id, 10);
      expect((await report("/Stopped", 210)).status).toBe(204);
      expect((await report("/Stopped", 210)).status).toBe(204);
      const recorded = await db.select().from(plays);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.userId).toBe(s.viewer.id);
      expect(recorded[0]?.playedSeconds).toBeCloseTo(210, 0);
    }));

  test("a web switch mid-film continues its play instead of adding one", () =>
    withDatabase(async (db) => {
      const s = await seedBrowse(db);
      // The player closes its session and reopens where it stopped, twice.
      const first = await openSession(db, s.viewer.id, s.matrix.id);
      await startPlayback(db, s.viewer.id, first, 0);
      await elapse(db, first.sessionId, 90);
      await stopPlayback(db, s.viewer.id, first, { positionSeconds: 90 });
      const second = await openSession(db, s.viewer.id, s.matrix.id);
      await startPlayback(db, s.viewer.id, second, 90);
      await elapse(db, second.sessionId, 60);
      await stopPlayback(db, s.viewer.id, second, { positionSeconds: 150 });
      const third = await openSession(db, s.viewer.id, s.matrix.id);
      await startPlayback(db, s.viewer.id, third, 150);
      await elapse(db, third.sessionId, 60);
      await stopPlayback(db, s.viewer.id, third, { positionSeconds: 210 });

      const [opened] = await db
        .select({ createdAt: sessionRegistry.createdAt })
        .from(sessionRegistry)
        .where(eq(sessionRegistry.id, first.sessionId));
      const recorded = await db.select().from(plays);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        sessionId: first.sessionId,
        startedAt: opened?.createdAt,
      });
      expect(recorded[0]?.playedSeconds).toBeCloseTo(210, 0);
    }));

  test("a Jellyfin stream switch continues its play instead of adding one", () =>
    withDatabase(async (db) => {
      const s = await seedBrowse(db);
      const header =
        'MediaBrowser Client="Jellyfin Web", Version="1", Device="Chrome", DeviceId="j1"';
      const send = async (request: Request) => {
        const response = await createJellyfinHandler(
          db,
          jellyfinRoutes(createArtworkHandler(db), createHlsHandler(db)),
        )(request, "127.0.0.1");
        if (response === undefined) throw new Error("Unrouted.");
        return response;
      };
      const token = await jellyfinLogin(send, header);
      const report = (path: string, sessionId: string, seconds: number) =>
        send(
          new Request(`http://thalia.test/Sessions/Playing${path}`, {
            method: "POST",
            headers: {
              authorization: `${header}, Token="${token}"`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              ItemId: toGuid(s.matrix.id),
              PlaySessionId: toGuid(sessionId),
              PositionTicks: seconds * 10_000_000,
            }),
          }),
        );
      const first = await openSession(db, s.viewer.id, s.matrix.id);
      expect((await report("", first.sessionId, 0)).status).toBe(204);
      await elapse(db, first.sessionId, 100);
      expect((await report("/Progress", first.sessionId, 100)).status).toBe(
        204,
      );
      // A new audio track brings a new PlaySessionId and no stop for the old one.
      const second = await openSession(db, s.viewer.id, s.matrix.id);
      expect((await report("/Progress", second.sessionId, 100)).status).toBe(
        204,
      );
      await elapse(db, second.sessionId, 60);
      expect((await report("/Progress", second.sessionId, 160)).status).toBe(
        204,
      );
      const recorded = await db.select().from(plays);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.playedSeconds).toBeCloseTo(160, 0);
    }));

  test("starting over, or resuming later, records another play", () =>
    withDatabase(async (db) => {
      const s = await seedBrowse(db);
      const watch = async (from: number, seconds: number) => {
        const scope = await openSession(db, s.viewer.id, s.matrix.id);
        await startPlayback(db, s.viewer.id, scope, from);
        await elapse(db, scope.sessionId, seconds);
        await stopPlayback(db, s.viewer.id, scope, {
          positionSeconds: from + seconds,
        });
      };
      await watch(0, 180);
      await watch(0, 180);
      expect(await db.select().from(plays)).toHaveLength(2);

      await db.update(sessionRegistry).set({
        lastSeenAt: sql`${sessionRegistry.lastSeenAt} - interval '1 hour'`,
      });
      await watch(180, 180);
      expect(await db.select().from(plays)).toHaveLength(3);
    }));

  test("a percentage threshold counts against the runtime, and finishing always counts", () =>
    withDatabase(async (db, url) => {
      const s = await seedBrowse(db);
      const server = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const { token } = await login(
          db,
          { username: "admin", password: "admin-pass", ...device },
          "127.0.0.1",
        );
        const client = createThaliaClient({
          origin: `http://127.0.0.1:${server.apiServer?.port}`,
          headers: { authorization: `Bearer ${token}` },
        });
        const rejected = await client.settings
          .update({
            watchThresholds: { movies: { unit: "percent", value: 120 } },
          })
          .catch((error: unknown) => error);
        expect(rejected).toBeInstanceOf(ORPCError);
        const saved = await client.settings.update({
          watchThresholds: { movies: { unit: "percent", value: 10 } },
        });
        expect(saved.watchThresholds).toEqual({
          movies: { unit: "percent", value: 10 },
          shows: { unit: "minutes", value: 2 },
        });
      } finally {
        await server.stop();
      }

      // 10% of The Matrix's 8160 s is 816 s; 600 s doesn't pass.
      const short = await openSession(db, s.viewer.id, s.matrix.id);
      await startPlayback(db, s.viewer.id, short, 0);
      await elapse(db, short.sessionId, 600);
      await stopPlayback(db, s.viewer.id, short, { positionSeconds: 600 });
      expect(await db.select().from(plays)).toEqual([]);

      const long = await openSession(db, s.viewer.id, s.matrix.id);
      await startPlayback(db, s.viewer.id, long, 0);
      await elapse(db, long.sessionId, 900);
      await updatePlayback(db, s.viewer.id, long, { positionSeconds: 900 });
      expect(await db.select().from(plays)).toHaveLength(1);

      // Resumed for its last 5%: short of 10%, but the Item is now watched.
      const ending = await openSession(db, s.viewer.id, s.matrix.id);
      await startPlayback(db, s.viewer.id, ending, 7750);
      await elapse(db, ending.sessionId, 400);
      await stopPlayback(db, s.viewer.id, ending, { positionSeconds: 8150 });
      expect(await db.select().from(plays)).toHaveLength(2);
    }));

  test("viewers see their own history and admins see everyone's", () =>
    withDatabase(async (db) => {
      const s = await seedBrowse(db);
      for (const [userId, itemId] of [
        [s.viewer.id, s.matrix.id],
        [s.admin.id, s.arrival.id],
      ] as const) {
        const scope = await openSession(db, userId, itemId);
        await startPlayback(db, userId, scope, 0);
        await elapse(db, scope.sessionId, 300);
        await stopPlayback(db, userId, scope, { positionSeconds: 300 });
      }

      const own = await listHistory(db, s.viewer.id, {});
      expect(own.items.map((play) => play.item.id)).toEqual([s.matrix.id]);
      await expect(
        listHistory(db, s.viewer.id, { everyone: true }),
      ).rejects.toEqual(new AuthError("FORBIDDEN"));
      await expect(historyInsights(db, s.viewer.id)).rejects.toEqual(
        new AuthError("FORBIDDEN"),
      );
      const everyone = await listHistory(db, s.admin.id, { everyone: true });
      expect(everyone.items.map((play) => play.user.id).sort()).toEqual(
        [s.viewer.id, s.admin.id].sort(),
      );
    }));

  test("insights total the weeks, rank titles with Episodes under their Show, and split play methods", () =>
    withDatabase(async (db) => {
      const s = await seedBrowse(db);
      const watch = async (
        userId: string,
        itemId: string,
        seconds: number,
        method: "direct-play" | "transcode" = "direct-play",
      ) => {
        const scope = await openSession(db, userId, itemId, method);
        await startPlayback(db, userId, scope, 0);
        await elapse(db, scope.sessionId, seconds);
        await stopPlayback(db, userId, scope, { positionSeconds: seconds });
      };
      await watch(s.viewer.id, s.episodeOne.id, 1200);
      await watch(s.viewer.id, s.episodeTwo.id, 1200, "transcode");
      await watch(s.admin.id, s.matrix.id, 600);
      // Last month's play counts in its own week.
      await db
        .update(plays)
        .set({
          startedAt: sql`${plays.startedAt} - interval '4 weeks'`,
        })
        .where(eq(plays.itemId, s.matrix.id));

      const insights = await historyInsights(db, s.admin.id);
      expect(insights.weeks).toHaveLength(12);
      expect(insights.weeks.at(-1)?.seconds).toBeCloseTo(2400, 0);
      expect(insights.weeks.at(-5)?.seconds).toBeCloseTo(600, 0);
      expect(
        insights.weeks.reduce((sum, week) => sum + week.seconds, 0),
      ).toBeCloseTo(3000, 0);
      expect(
        insights.topTitles.map((title) => [title.item.id, title.plays]),
      ).toEqual([
        [s.show.id, 2],
        [s.matrix.id, 1],
      ]);
      expect(insights.topUsers.map((user) => user.user.id)).toEqual([
        s.viewer.id,
        s.admin.id,
      ]);
      expect(insights.methods.directPlay).toBeCloseTo(1800, 0);
      expect(insights.methods.transcode).toBeCloseTo(1200, 0);
      expect(insights.methods.remux).toBe(0);
    }));
});
