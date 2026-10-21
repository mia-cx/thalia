import { describe, expect, test } from "bun:test";
import { createHlsHandler } from "../api/hls.ts";
import { seedBrowse } from "../api/view-fixtures.ts";
import { setRule } from "../auth/rules.ts";
import type { Database } from "../db/client.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createArtworkHandler } from "../metadata/artwork-http.ts";
import { createJellyfinHandler } from "./http.ts";
import { itemGuid } from "./ids.ts";
import { jellyfinRoutes } from "./routes.ts";
import { jellyfinLogin } from "./testing.ts";

const infuse =
  'MediaBrowser Client="Infuse-Direct", Version="8.5.6", Device="Apple TV", DeviceId="infuse-1"';

type Item = {
  Name: string;
  ChildCount?: number;
  CanDownload?: boolean;
};
type Result = { Items: Item[]; TotalRecordCount: number };

// The browse fixture's viewer, given only Severance: denied the server, allowed the show.
async function restricted(db: Database) {
  const s = await seedBrowse(db);
  const viewer = { type: "user" as const, id: s.viewer.id };
  await setRule(db, s.admin.id, {
    subject: viewer,
    object: { type: "server" },
    action: "view",
    allowed: false,
  });
  await setRule(db, s.admin.id, {
    subject: viewer,
    object: { type: "item", id: s.show.id },
    action: "view",
    allowed: true,
  });
  const handle = createJellyfinHandler(
    db,
    jellyfinRoutes(createArtworkHandler(db), createHlsHandler(db)),
  );
  const token = await jellyfinLogin(
    (request) => handle(request, "127.0.0.1"),
    infuse,
    "viewer",
    "viewer-pass",
  );
  const send = async (path: string, method = "GET") => {
    const response = await handle(
      new Request(`http://thalia.test${path}`, {
        method,
        headers: {
          Authorization: `${infuse}, Token="${token}"`,
          "content-type": "application/json",
        },
        body: method === "POST" ? "{}" : undefined,
      }),
      "127.0.0.1",
    );
    if (response === undefined) throw new Error(`${path} unrouted`);
    return response;
  };
  const get = async <T = Result>(path: string) => {
    const response = await send(path);
    expect(response.status, path).toBe(200);
    return (await response.json()) as T;
  };
  return { s, send, get };
}

const names = (result: Result | Item[]) =>
  (Array.isArray(result) ? result : result.Items).map((item) => item.Name);

describe.skipIf(!databaseUrl)("Jellyfin apps honour Item rules", () => {
  // Proves Infuse's browse, shelf and search requests show a one-show account only that show's tree, with matching counts.
  test("Infuse sees only the show an account was given", () =>
    withDatabase(async (db) => {
      const { s, get } = await restricted(db);
      const show = itemGuid(s.show.id, s.tv.id);

      const views = await get("/UserViews");
      expect(names(views)).toEqual(["Shows"]);
      expect(views.TotalRecordCount).toBe(1);
      expect(
        (await get<{ ChildCount: number }>("/Items/Root")).ChildCount,
      ).toBe(1);
      const everything = await get("/Items?Recursive=true&SortBy=SortName");
      expect(names(everything)).toEqual([
        "Good News About Hell",
        "Half Loop",
        "Season 1",
        "Severance",
      ]);
      expect(everything.TotalRecordCount).toBe(4);
      const series = await get(
        `/Items?ParentId=${s.tv.id}&Recursive=true&IncludeItemTypes=Movie,Series`,
      );
      expect(series.Items).toMatchObject([
        { Name: "Severance", ChildCount: 1 },
      ]);
      expect(series.TotalRecordCount).toBe(1);
      expect(
        (await get(`/Items?ParentId=${s.films.id}&Recursive=true`))
          .TotalRecordCount,
      ).toBe(0);
      expect(names(await get(`/Shows/${show}/Seasons`))).toEqual(["Season 1"]);
      const episodes = await get(`/Shows/${show}/Episodes`);
      expect(names(episodes)).toEqual(["Good News About Hell", "Half Loop"]);
      // The show's own rule decides its downloads, not the denied Library.
      expect(episodes.Items.every((item) => item.CanDownload)).toBe(true);

      expect(names(await get<Item[]>("/Items/Latest"))).toEqual(["Severance"]);
      // The viewer's started Matrix is hidden; next up stays inside the show.
      expect(names(await get("/UserItems/Resume"))).toEqual([]);
      expect(names(await get("/Shows/NextUp"))).toEqual(["Half Loop"]);
      expect(
        names(await get("/Items?SearchTerm=matrx&Recursive=true")),
      ).toEqual([]);
      expect(
        names(
          (
            await get<{ SearchHints: Item[] }>(
              "/Search/Hints?searchTerm=Severance",
            )
          ).SearchHints,
        ),
      ).toEqual(["Severance"]);
      expect(await get("/Items/Counts")).toMatchObject({
        MovieCount: 0,
        SeriesCount: 1,
        EpisodeCount: 2,
      });
    }));

  // Proves a hidden Item's media is refused on every route a player fetches it by.
  test("playback info, stream, file and download refuse a hidden Item", () =>
    withDatabase(async (db) => {
      const { s, send } = await restricted(db);
      const allowed = itemGuid(s.episodeOne.id, s.tv.id);
      expect((await send(`/Items/${allowed}/PlaybackInfo`)).status).toBe(200);

      const hidden = itemGuid(s.matrix.id, s.films.id);
      for (const [path, method] of [
        [`/Items/${hidden}/PlaybackInfo`, "GET"],
        [`/Items/${hidden}/PlaybackInfo`, "POST"],
        [`/Videos/${hidden}/stream?static=true`, "GET"],
        [`/Items/${hidden}/File`, "GET"],
        [`/Items/${hidden}/Download`, "GET"],
      ] as const) {
        const response = await send(path, method);
        expect([403, 404], `${method} ${path}`).toContain(response.status);
      }
    }));
});
