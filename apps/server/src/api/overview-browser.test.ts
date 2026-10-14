import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { setupAdmin } from "../auth/accounts.ts";
import { login } from "../auth/sessions.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { artwork, items, providerIds } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { insertItem } from "../db/tree.ts";
import { startThalia } from "../index.ts";
import { listJobs } from "../jobs/queue.ts";
import { insertLibraries } from "../libraries/testing.ts";
import { withFolder } from "../plugins/testing.ts";
import { browser, openPage, signIn, webBuild } from "./browser-testing.ts";
import { publishEvent } from "./events.ts";

const clickButton = (label: string) =>
  `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)})?.click()`;

describe.skipIf(!databaseUrl || browser === undefined)(
  "admin overview page",
  () => {
    beforeAll(() => {
      if (!existsSync(webBuild))
        throw new Error("Build apps/web before this test.");
    });

    test("a gap row opens its items, refreshes one and follows the event", () =>
      withFolder((folder) =>
        withDatabase(async (db, url) => {
          if (browser === undefined) throw new Error("Expected a browser.");
          await migrateDatabase(db);
          await setupAdmin(db, {
            username: "admin",
            password: "admin-pass",
          });
          const { token } = await login(
            db,
            {
              username: "admin",
              password: "admin-pass",
              clientName: "Thalia Web",
              deviceId: "overview-browser",
              deviceName: "Chromium",
            },
            "127.0.0.1",
          );
          const [library] = await insertLibraries(db, {
            name: "Movies",
            medium: "movies",
            rootPath: folder,
          });
          if (library === undefined) throw new Error("Fixture missing.");
          const movie = await insertItem(db, {
            libraryId: library.id,
            kind: "movie",
            title: "Alien",
            canonicalFolder: "/movies/alien",
            extension: {},
          });
          await db.insert(artwork).values([
            {
              itemId: movie.id,
              type: "poster",
              backend: "colocated",
              storageKey: "alien/poster.jpg",
              selected: true,
            },
            {
              itemId: movie.id,
              type: "backdrop",
              backend: "colocated",
              storageKey: "alien/backdrop.jpg",
              selected: true,
            },
          ]);
          await db
            .insert(providerIds)
            .values({ itemId: movie.id, provider: "tmdb", value: "348" });

          const server = await startThalia("api", {
            databaseUrl: url,
            port: 0,
            pluginOptions: { directory: `${folder}/installed` },
          });
          const page = await openPage();
          try {
            const base = `http://127.0.0.1:${server.apiServer?.port}`;
            await signIn(page, base, token, "/admin/overview");

            // Only the overview gap is non-zero; its row is the button to open.
            await page.waitFor(
              "[...document.querySelectorAll('button')].some(b => b.textContent.includes('No overview') && b.textContent.includes('1'))",
            );
            await page.eval(
              "[...document.querySelectorAll('button')].find(b => b.textContent.includes('No overview'))?.click()",
            );
            await page.waitFor(
              "[...document.querySelectorAll('a, span')].some(e => e.textContent.trim() === 'Alien')",
            );
            await page.waitFor(
              "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Refresh metadata')",
            );
            await page.eval(clickButton("Refresh metadata"));
            await page.waitFor(
              "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Refresh queued')",
            );

            const queued = await listJobs(db, { type: "provider-fetch" });
            expect(
              queued.some(
                (job) =>
                  job.payload.type === "provider-fetch" &&
                  job.payload.itemId === movie.id,
              ),
            ).toBe(true);

            // What the job would do, then the change event the page follows.
            await db
              .update(items)
              .set({ overview: "A crawler hunts a crew." })
              .where(eq(items.id, movie.id));
            await publishEvent(db, {
              kind: "library.changed",
              libraryId: library.id,
            });
            await page.waitFor(
              "[...document.querySelectorAll('*')].some(e => e.textContent.trim() === '0 in Movies')",
            );
            await page.waitFor(
              "[...document.querySelectorAll('button')].every(b => !b.textContent.includes('No overview')) || [...document.querySelectorAll('button')].some(b => b.textContent.includes('No overview') && b.textContent.trim().endsWith('0'))",
            );
            // The reconciled list drops the fixed Item and shows its empty state.
            await page.waitFor(
              "[...document.querySelectorAll('[data-slot=dialog-content] a')].every(a => a.textContent.trim() !== 'Alien') && [...document.querySelectorAll('[data-slot=dialog-content] *')].some(e => e.textContent.trim() === 'Nothing missing.')",
            );
          } finally {
            await page.close();
            await server.stop();
          }
        }),
      ));

    test("a gap with more than one page lists every row without resetting", () =>
      withFolder((folder) =>
        withDatabase(async (db, url) => {
          if (browser === undefined) throw new Error("Expected a browser.");
          await migrateDatabase(db);
          await setupAdmin(db, {
            username: "admin",
            password: "admin-pass",
          });
          const { token } = await login(
            db,
            {
              username: "admin",
              password: "admin-pass",
              clientName: "Thalia Web",
              deviceId: "overview-browser-paging",
              deviceName: "Chromium",
            },
            "127.0.0.1",
          );
          const [library] = await insertLibraries(db, {
            name: "Movies",
            medium: "movies",
            rootPath: folder,
          });
          if (library === undefined) throw new Error("Fixture missing.");
          // One more than a page of Items missing their poster.
          for (let i = 1; i <= 25; i += 1) {
            const movie = await insertItem(db, {
              libraryId: library.id,
              kind: "movie",
              title: `Gap Movie ${String(i).padStart(2, "0")}`,
              overview: "Set.",
              canonicalFolder: `/movies/gap-${i}`,
              extension: {},
            });
            await db.insert(artwork).values({
              itemId: movie.id,
              type: "backdrop",
              backend: "colocated",
              storageKey: `gap-${i}/backdrop.jpg`,
              selected: true,
            });
            await db
              .insert(providerIds)
              .values({ itemId: movie.id, provider: "tmdb", value: `${i}` });
          }

          const server = await startThalia("api", {
            databaseUrl: url,
            port: 0,
            pluginOptions: { directory: `${folder}/installed` },
          });
          const page = await openPage();
          const dialogLinks =
            "document.querySelectorAll('[data-slot=dialog-content] a').length";
          try {
            const base = `http://127.0.0.1:${server.apiServer?.port}`;
            await signIn(page, base, token, "/admin/overview");
            await page.waitFor(
              "[...document.querySelectorAll('button')].some(b => b.textContent.includes('No poster'))",
            );
            await page.eval(
              "[...document.querySelectorAll('button')].find(b => b.textContent.includes('No poster'))?.click()",
            );
            await page.waitFor(`${dialogLinks} === 24`);
            await page.waitFor(
              "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Show more')",
            );
            await page.eval(clickButton("Show more"));
            await page.waitFor(`${dialogLinks} === 25`);
            await page.waitFor(
              "[...document.querySelectorAll('button')].every(b => b.textContent.trim() !== 'Show more')",
            );
            // A reset loop would drop back to the first page within a second.
            await Bun.sleep(1000);
            expect(await page.eval<number>(dialogLinks)).toBe(25);
            expect(
              await page.eval<boolean>(
                "[...document.querySelectorAll('button')].every(b => b.textContent.trim() !== 'Show more')",
              ),
            ).toBe(true);
          } finally {
            await page.close();
            await server.stop();
          }
        }),
      ));
    test("a slow first page from a closed opening never lands", () =>
      withFolder((folder) =>
        withDatabase(async (db, url) => {
          if (browser === undefined) throw new Error("Expected a browser.");
          await migrateDatabase(db);
          await setupAdmin(db, {
            username: "admin",
            password: "admin-pass",
          });
          const { token } = await login(
            db,
            {
              username: "admin",
              password: "admin-pass",
              clientName: "Thalia Web",
              deviceId: "overview-browser-stale",
              deviceName: "Chromium",
            },
            "127.0.0.1",
          );
          const [library] = await insertLibraries(db, {
            name: "Movies",
            medium: "movies",
            rootPath: folder,
          });
          if (library === undefined) throw new Error("Fixture missing.");
          // A is in both lists; B only in the poster list.
          const both = await insertItem(db, {
            libraryId: library.id,
            kind: "movie",
            title: "Both Gaps",
            overview: "Set.",
            canonicalFolder: "/movies/both",
            extension: {},
          });
          const posterOnly = await insertItem(db, {
            libraryId: library.id,
            kind: "movie",
            title: "Poster Only",
            overview: "Set.",
            canonicalFolder: "/movies/poster-only",
            extension: {},
          });
          await db.insert(artwork).values({
            itemId: posterOnly.id,
            type: "backdrop",
            backend: "colocated",
            storageKey: "po/backdrop.jpg",
            selected: true,
          });
          for (const movie of [both, posterOnly])
            await db.insert(providerIds).values({
              itemId: movie.id,
              provider: "tmdb",
              value: movie.title,
            });

          const server = await startThalia("api", {
            databaseUrl: url,
            port: 0,
            pluginOptions: { directory: `${folder}/installed` },
          });
          const page = await openPage();
          try {
            const base = `http://127.0.0.1:${server.apiServer?.port}`;
            await signIn(page, base, token, "/admin/overview");
            await page.waitFor(
              "[...document.querySelectorAll('button')].some(b => b.textContent.includes('No poster'))",
            );

            // Hold the first metadataGapItems response; later ones pass.
            const held: { requestId: string }[] = [];
            await page.send("Fetch.enable", {
              patterns: [
                { urlPattern: "*metadataGapItems*", requestStage: "Request" },
              ],
            });
            let firstHeld = false;
            page.on(
              "Fetch.requestPaused",
              (p: { requestId: string; request: { url: string } }) => {
                if (!firstHeld) {
                  firstHeld = true;
                  held.push({ requestId: p.requestId });
                  return;
                }
                void page.send("Fetch.continueRequest", {
                  requestId: p.requestId,
                });
              },
            );

            await page.eval(
              "[...document.querySelectorAll('button')].find(b => b.textContent.includes('No poster'))?.click()",
            );
            await page.waitFor(
              "document.querySelector('[data-slot=dialog-content]') !== null",
            );
            await Bun.sleep(400);
            if (held.length !== 1)
              throw new Error("The first gap request was not held.");

            // Close, then open the backdrop gap; its request goes through.
            await page.eval(
              "[...document.querySelectorAll('[data-slot=dialog-content] button')].find(b => (b.getAttribute('aria-label') ?? '').includes('Close') || b.textContent.trim() === 'Close')?.click()",
            );
            await page.waitFor(
              "document.querySelector('[data-slot=dialog-content]') === null",
            );
            await page.eval(
              "[...document.querySelectorAll('button')].find(b => b.textContent.includes('No backdrop'))?.click()",
            );
            // Release the stale response while the new opening loads; the list
            // must still end up the backdrop gap's, with no duplicates.
            await page.send("Fetch.continueRequest", {
              requestId: held[0]?.requestId,
            });
            await page.waitFor(
              "[...document.querySelectorAll('[data-slot=dialog-content] a')].length === 1",
            );
            await Bun.sleep(400);
            const titles = await page.eval<string[]>(
              "[...document.querySelectorAll('[data-slot=dialog-content] a')].map(a => a.textContent.trim())",
            );
            expect(titles).toEqual(["Both Gaps"]);
          } finally {
            await page.close();
            await server.stop();
          }
        }),
      ));
  },
);
