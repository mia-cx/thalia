import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createHlsHandler } from "../api/hls.ts";
import { seedBrowse } from "../api/view-fixtures.ts";
import type { Database } from "../db/client.ts";
import { files, versions } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createArtworkHandler } from "../metadata/artwork-http.ts";
import { createJellyfinHandler } from "./http.ts";
import { toGuid } from "./request.ts";
import { jellyfinRoutes } from "./routes.ts";
import { jellyfinLogin } from "./testing.ts";

const infuse =
  'MediaBrowser Client="Infuse-Direct", Version="7.7", Device="Apple TV", DeviceId="infuse-1"';

async function client(db: Database) {
  const handle = createJellyfinHandler(
    db,
    jellyfinRoutes(createArtworkHandler(db), createHlsHandler(db)),
  );
  const token = await jellyfinLogin(
    (request) => handle(request, "127.0.0.1"),
    infuse,
  );
  return (path: string) =>
    handle(
      new Request(`http://thalia.test${path}`, {
        headers: { "X-Emby-Authorization": `${infuse}, Token="${token}"` },
      }),
      "127.0.0.1",
    );
}

describe.skipIf(!databaseUrl)("jellyfin media segments", () => {
  test("a credits chapter becomes one stable Outro segment", () =>
    withDatabase(async (db) => {
      const s = await seedBrowse(db);
      const [episodeVersion] = await db
        .select()
        .from(versions)
        .where(eq(versions.itemId, s.episodeOne.id));
      if (!episodeVersion) throw new Error("Episode version missing.");
      await db
        .update(versions)
        .set({ durationSeconds: 120 })
        .where(eq(versions.id, episodeVersion.id));
      await db
        .update(files)
        .set({
          durationSeconds: 120,
          chapters: [
            { title: "Opening", startSeconds: 0, endSeconds: 100 },
            { title: "Credits", startSeconds: 100, endSeconds: 120 },
          ],
        })
        .where(eq(files.versionId, episodeVersion.id));
      const call = await client(db);
      const item = toGuid(s.episodeOne.id);

      const response = await call(`/MediaSegments/${item}`);
      expect(response?.status).toBe(200);
      const body = (await response?.json()) as {
        Items: {
          Id: string;
          ItemId: string;
          Type: string;
          StartTicks: number;
          EndTicks: number;
        }[];
        TotalRecordCount: number;
        StartIndex: number;
      };
      expect(body.TotalRecordCount).toBe(1);
      expect(body.StartIndex).toBe(0);
      expect(body.Items).toHaveLength(1);
      expect(body.Items[0]).toMatchObject({
        ItemId: item,
        Type: "Outro",
        StartTicks: 100 * 10_000_000,
        EndTicks: 120 * 10_000_000,
      });
      const id = body.Items[0]?.Id;
      expect(id).toMatch(/^[0-9a-f]{32}$/);

      // The same request repeats the same deterministic segment id.
      const again = (await (
        await call(`/MediaSegments/${item}`)
      )?.json()) as typeof body;
      expect(again.Items[0]?.Id).toBe(id);

      // A caller asking only for other types sees no segment.
      const filtered = (await (
        await call(`/MediaSegments/${item}?includeSegmentTypes=Intro`)
      )?.json()) as typeof body;
      expect(filtered.Items).toEqual([]);
      expect(filtered.TotalRecordCount).toBe(0);
      // And asking for Outro keeps it.
      const wanted = (await (
        await call(`/MediaSegments/${item}?includeSegmentTypes=Intro,Outro`)
      )?.json()) as typeof body;
      expect(wanted.Items).toHaveLength(1);
    }));

  test("no credits chapter, no file and no view all answer empty or 404", () =>
    withDatabase(async (db) => {
      const s = await seedBrowse(db);
      const call = await client(db);

      // A versioned Episode without a credits chapter has no segments.
      const empty = (await (
        await call(`/MediaSegments/${toGuid(s.episodeTwo.id)}`)
      )?.json()) as { Items: unknown[]; TotalRecordCount: number };
      expect(empty.Items).toEqual([]);
      expect(empty.TotalRecordCount).toBe(0);

      // The caller-invisible Item answers not found like every Item route.
      const hidden = await call(`/MediaSegments/${toGuid(s.secret.id)}`);
      expect(hidden?.status).toBe(404);
    }));
});
