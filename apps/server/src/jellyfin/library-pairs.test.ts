import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startThalia } from "../index.ts";
import { scanDirectory, scanShowDirectory } from "../libraries/scan.ts";
import { createLibrary } from "../libraries/service.ts";
import { createVideoFixture } from "../mediums/video-common/fixtures.ts";
import { jellyfinLogin } from "./testing.ts";

const infuse =
  'MediaBrowser Client="Infuse-Direct", Version="8.5", Device="Apple TV", DeviceId="infuse-1"';
const film = "Twin (2026) [tmdbid-424242]";
const show = "Split (2020) [tvdbid-4242]";

type Item = {
  Id: string;
  Name: string;
  UserData: { Played: boolean; ItemId: string };
  MediaSources?: { Path: string }[];
};
type Result = { Items: Item[]; TotalRecordCount: number };
type Message = { MessageType: string; Data?: unknown };

// Bun's client sends headers; the DOM typings only know the protocols argument.
const HeaderSocket = WebSocket as unknown as new (
  url: string,
  options: Bun.WebSocketOptions,
) => WebSocket;

describe.skipIf(!databaseUrl)("one Jellyfin item per Item and Library", () => {
  let root: string;

  // The same tagged film in two movie Libraries, and one tagged show whose
  // Seasons sit in two show Libraries.
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "thalia-jellyfin-pairs-"));
    for (const copy of ["a", "b"]) {
      await mkdir(join(root, "films", copy, film), { recursive: true });
      await mkdir(join(root, "shows", copy, show), { recursive: true });
    }
    await createVideoFixture(join(root, "films", "a", film, "Twin.mkv"));
    await cp(
      join(root, "films", "a", film, "Twin.mkv"),
      join(root, "films", "b", film, "Twin.mkv"),
    );
    await cp(
      join(root, "films", "a", film, "Twin.mkv"),
      join(root, "shows", "a", show, "Split S01E01.mkv"),
    );
    await cp(
      join(root, "films", "a", film, "Twin.mkv"),
      join(root, "shows", "b", show, "Split S02E01.mkv"),
    );
  }, 30_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // Proves Infuse sees each Library's own copy under a stable id, with marks shared through the server Item.
  test("Infuse browses a film and a show held in two Libraries", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const admin = await setupAdmin(db, {
        username: "admin",
        password: "admin-pass",
      });
      await createLocalUser(db, admin.id, {
        username: "viewer",
        password: "viewer-pass",
      });
      const library = (medium: "movies" | "shows", copy: string) =>
        createLibrary(db, admin.id, {
          name: `${medium} ${copy}`,
          medium,
          roots: [join(root, medium === "movies" ? "films" : "shows", copy)],
        });
      const films = [
        await library("movies", "a"),
        await library("movies", "b"),
      ];
      const shows = [await library("shows", "a"), await library("shows", "b")];
      const scan = async () => {
        for (const { id } of films) await scanDirectory(db, id, film);
        for (const { id } of shows) await scanShowDirectory(db, id, show);
      };
      await scan();

      const thalia = await startThalia("api", {
        databaseUrl: url,
        port: 0,
        brokerOptions: { pollIntervalMs: 200 },
      });
      try {
        const base = `http://127.0.0.1:${thalia.apiServer?.port}`;
        const token = await jellyfinLogin(
          (request) =>
            fetch(new URL(new URL(request.url).pathname, base), request),
          infuse,
        );
        const headers = {
          "X-Emby-Authorization": `${infuse}, Token="${token}"`,
        };
        const get = async <T = Result>(path: string) => {
          const response = await fetch(`${base}${path}`, { headers });
          expect(response.status, path).toBe(200);
          return (await response.json()) as T;
        };
        const twins = async () =>
          Promise.all(
            films.map(async ({ id }) => {
              const listed = await get(
                `/Items?ParentId=${id}&Recursive=true&IncludeItemTypes=Movie&Fields=MediaSources,Path`,
              );
              expect(listed.Items.map((item) => item.Name)).toEqual(["Twin"]);
              const [twin] = listed.Items;
              if (twin === undefined) throw new Error("Missing film.");
              return twin;
            }),
          );

        const [inA, inB] = await twins();
        if (inA === undefined || inB === undefined)
          throw new Error("Missing films.");
        expect(inA.Id).not.toBe(inB.Id);
        for (const [twin, copy] of [
          [inA, "a"],
          [inB, "b"],
        ] as const) {
          const sources = [
            twin.MediaSources,
            (await get<Item>(`/Items/${twin.Id}`)).MediaSources,
            (await get<Item>(`/Items/${twin.Id}/PlaybackInfo`)).MediaSources,
          ];
          for (const listed of sources)
            expect(listed?.map((source) => source.Path)).toEqual([
              join(root, "films", copy, film, "Twin.mkv"),
            ]);
        }

        const seasons = await Promise.all(
          shows.map(async ({ id }) => {
            const [series] = (
              await get(
                `/Items?ParentId=${id}&Recursive=true&IncludeItemTypes=Series`,
              )
            ).Items;
            if (series === undefined) throw new Error("Missing show.");
            return {
              series: series.Id,
              seasons: (await get(`/Shows/${series.Id}/Seasons`)).Items.map(
                (season) => season.Name,
              ),
              episodes: (await get(`/Shows/${series.Id}/Episodes`)).Items.map(
                (episode) => episode.Name,
              ),
            };
          }),
        );
        expect(seasons[0]?.series).not.toBe(seasons[1]?.series);
        expect(seasons.map(({ seasons }) => seasons)).toEqual([
          ["Season 1"],
          ["Season 2"],
        ]);
        expect(seasons.map(({ episodes }) => episodes.length)).toEqual([1, 1]);

        // Watching through one Library marks the film watched in the other,
        // and the socket names both ids the client holds.
        const socket = new HeaderSocket(
          `${base.replace("http", "ws")}/socket`,
          {
            headers,
          },
        );
        const messages: Message[] = [];
        socket.addEventListener("message", (event) =>
          messages.push(JSON.parse(String(event.data))),
        );
        await new Promise((resolve) =>
          socket.addEventListener("open", resolve),
        );
        try {
          const played = await fetch(`${base}/UserPlayedItems/${inA.Id}`, {
            method: "POST",
            headers,
          });
          expect(played.status).toBe(200);
          expect((await get<Item>(`/Items/${inB.Id}`)).UserData.Played).toBe(
            true,
          );
          let changed: Message | undefined;
          for (let waited = 0; changed === undefined && waited < 10_000; ) {
            changed = messages.find(
              (message) => message.MessageType === "UserDataChanged",
            );
            await Bun.sleep(20);
            waited += 20;
          }
          if (changed === undefined) throw new Error("No UserDataChanged.");
          const list = (changed.Data as { UserDataList: Item["UserData"][] })
            .UserDataList;
          expect(list.map((data) => data.ItemId).sort()).toEqual(
            [inA.Id, inB.Id].sort(),
          );
          expect(list.every((data) => data.Played)).toBe(true);
        } finally {
          socket.close();
        }

        // A rescan keeps every id the client cached.
        await scan();
        expect((await twins()).map((twin) => twin.Id)).toEqual([
          inA.Id,
          inB.Id,
        ]);
      } finally {
        await thalia.stop();
      }
    }));
});
