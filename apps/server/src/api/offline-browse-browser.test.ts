import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { login } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { artwork, episodes, items } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startThalia } from "../index.ts";
import { scanDirectory, scanShowDirectory } from "../libraries/scan.ts";
import { createLibrary } from "../libraries/service.ts";
import { createVideoFixture } from "../mediums/video-common/fixtures.ts";
import { browser, openPage, signIn, webBuild } from "./browser-testing.ts";

const fixture = {
  width: 640,
  height: 360,
  durationSeconds: 2,
  frameRate: 25,
  gopSeconds: 1,
};

const byLabel = (label: string) =>
  `[...document.querySelectorAll('button, a')].some(b => (b.getAttribute('aria-label') ?? '') === ${JSON.stringify(label)})`;
const clickLabel = (label: string) =>
  `[...document.querySelectorAll('button, a')].find(b => (b.getAttribute('aria-label') ?? '') === ${JSON.stringify(label)})?.click()`;
const savedArtwork = `(async () => {
  const root = await navigator.storage.getDirectory();
  const dir = await (await root.getDirectoryHandle("downloads")).getDirectoryHandle("artwork");
  const names = [];
  for await (const name of dir.keys()) names.push(name);
  return names.sort();
})()`;

/** Writes a solid JPEG and selects it as the Item's artwork of `type`; answers its artwork id. */
async function addArtwork(
  db: Database,
  root: string,
  itemId: string,
  type: "poster" | "thumb",
  key: string,
) {
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=0x3355aa:s=${type === "poster" ? "200x300" : "320x180"}`,
      "-frames:v",
      "1",
      "-y",
      join(root, key),
    ],
    { stdout: "ignore", stderr: "inherit" },
  );
  if ((await proc.exited) !== 0) throw new Error("ffmpeg made no artwork.");
  const [row] = await db
    .insert(artwork)
    .values({
      itemId,
      type,
      backend: "colocated",
      storageKey: key,
      selected: true,
    })
    .returning();
  if (row === undefined) throw new Error("Seeding returned no artwork.");
  return row.id;
}

describe.skipIf(!databaseUrl || browser === undefined)(
  "offline Downloads",
  () => {
    test(
      "with the server stopped, downloads list with artwork, group by Show and Season, and open their pages",
      () =>
        withDatabase(async (db, url) => {
          if (browser === undefined) throw new Error("Expected a browser.");
          if (!existsSync(webBuild))
            throw new Error("Build apps/web before this test.");
          await migrateDatabase(db);
          const admin = await setupAdmin(db, {
            username: "admin",
            password: "admin-pass",
          });
          await createLocalUser(db, admin.id, {
            username: "viewer",
            password: "viewer-pass",
          });
          const { token } = await login(
            db,
            {
              username: "viewer",
              password: "viewer-pass",
              clientName: "Thalia Web",
              deviceId: "offline-browse",
              deviceName: "Chromium",
            },
            "127.0.0.1",
          );
          const moviesRoot = await mkdtemp(join(tmpdir(), "thalia-offline-m-"));
          const showsRoot = await mkdtemp(join(tmpdir(), "thalia-offline-s-"));
          let server: Awaited<ReturnType<typeof startThalia>> | undefined;
          const page = await openPage();
          try {
            for (const folder of ["Arrival (2016)", "Zodiac (2007)"]) {
              await mkdir(join(moviesRoot, folder));
              await createVideoFixture(
                join(moviesRoot, folder, `${folder}.mkv`),
                fixture,
              );
            }
            const season = join(showsRoot, "Severance", "Season 1");
            await mkdir(season, { recursive: true });
            for (const code of ["S01E02", "S01E01"])
              await createVideoFixture(
                join(season, `Severance ${code}.mkv`),
                fixture,
              );
            const movies = await createLibrary(db, admin.id, {
              name: "Movies",
              medium: "movies",
              roots: [moviesRoot],
            });
            const shows = await createLibrary(db, admin.id, {
              name: "Shows",
              medium: "shows",
              roots: [showsRoot],
            });
            const arrival = (
              await scanDirectory(db, movies.id, "Arrival (2016)")
            ).itemId;
            const zodiac = (await scanDirectory(db, movies.id, "Zodiac (2007)"))
              .itemId;
            const show = (await scanShowDirectory(db, shows.id, "Severance"))
              .itemId;
            if (arrival === null || zodiac === null || show === null)
              throw new Error("Expected two Movies and a Show.");
            const episodeRows = await db
              .select({
                id: items.id,
                seasonId: items.parentId,
                number: episodes.episodeNumber,
              })
              .from(episodes)
              .innerJoin(items, eq(items.id, episodes.itemId))
              .orderBy(episodes.episodeNumber);
            const episodePath = (row: (typeof episodeRows)[number]) =>
              `/shows/${show}/seasons/${row.seasonId}/episodes/${row.id}`;
            const arrivalPoster = await addArtwork(
              db,
              moviesRoot,
              arrival,
              "poster",
              "Arrival (2016)/poster.jpg",
            );
            const showPoster = await addArtwork(
              db,
              showsRoot,
              show,
              "poster",
              "Severance/poster.jpg",
            );

            server = await startThalia("api", { databaseUrl: url, port: 0 });
            const base = `http://127.0.0.1:${server.apiServer?.port}`;
            await signIn(page, base, token, `/movies/${arrival}`);
            // Downloads stay usable offline only once the service worker controls the page.
            await page.waitFor("navigator.serviceWorker.controller !== null");
            for (const path of [
              `/movies/${arrival}`,
              ...episodeRows.toReversed().map(episodePath),
            ]) {
              await page.goto(`${base}${path}`);
              await page.waitFor(byLabel("Download"), 30_000);
              await page.eval(clickLabel("Download"));
              await page.waitFor(byLabel("Downloaded"), 30_000);
            }
            // Visit Zodiac online so only its being downloaded, not its being unseen, differs.
            await page.goto(`${base}/movies/${zodiac}`);
            await page.waitFor(byLabel("Download"), 30_000);

            await server.stop();
            server = undefined;

            await page.goto(`${base}/downloads`);
            await page.waitFor(byLabel("Delete download"), 30_000);
            const listed = await page.eval<{
              headings: string[];
              rows: string[];
              images: number;
              loaded: boolean;
            }>(`(async () => {
              const main = document.querySelector("main");
              const images = [...main.querySelectorAll("img")];
              await Promise.all(images.map((img) => img.decode().catch(() => {})));
              return {
                headings: [...main.querySelectorAll("h2, h3")].map((h) => h.textContent.trim()),
                rows: [...main.querySelectorAll("a[href^='/movies/'], a[href^='/shows/']")].map((a) => a.textContent.replace(/\\s+/g, " ").trim()),
                images: images.length,
                loaded: images.every((img) => img.complete && img.naturalWidth > 0),
              };
            })()`);
            expect(listed.headings).toEqual([
              "Storage",
              "Movies",
              "Severance",
              "Season 1",
            ]);
            expect(listed.rows).toEqual([
              expect.stringContaining("Arrival (2016)"),
              expect.stringContaining("Episode 1"),
              expect.stringContaining("Episode 2"),
            ]);
            // Arrival's and Severance's posters, drawn from the saved copies.
            expect(listed.images).toBe(2);
            expect(listed.loaded).toBe(true);

            await page.goto(`${base}/movies/${arrival}`);
            await page.waitFor("document.title === 'Arrival · Thalia'", 30_000);
            const play = await page.eval<string | null>(
              `[...document.querySelectorAll('a')].find((a) => a.textContent.trim() === 'Play')?.getAttribute('href') ?? null`,
            );
            expect(play).toStartWith(`/play/${arrival}?version=`);
            // Play opens the download, with the server still down.
            await page.goto(`${base}${play}`);
            await page.waitFor(
              "document.querySelector('video')?.readyState >= 2",
              30_000,
            );

            await page.goto(`${base}/movies/${zodiac}`);
            await page.waitFor(
              "document.body.innerText.includes('Not available offline')",
              30_000,
            );

            await page.goto(`${base}/downloads`);
            await page.waitFor(byLabel("Delete download"), 30_000);
            expect(await page.eval<string[]>(savedArtwork)).toEqual(
              [arrivalPoster, showPoster].sort(),
            );
            await page.eval(clickLabel("Delete download"));
            await page.waitFor(
              "!document.body.innerText.includes('Arrival')",
              30_000,
            );
            // The row disappears before the index write and artwork cleanup finish.
            await page.waitFor(
              `(${savedArtwork}).then((names) => names.length === 1 && names[0] === ${JSON.stringify(showPoster)})`,
              30_000,
            );
            expect(await page.eval<string[]>(savedArtwork)).toEqual([
              showPoster,
            ]);
          } finally {
            await page.close();
            await server?.stop();
            await rm(moviesRoot, { recursive: true, force: true });
            await rm(showsRoot, { recursive: true, force: true });
          }
        }),
      180_000,
    );
  },
);
