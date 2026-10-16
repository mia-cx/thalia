import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createThaliaClient } from "../../../web/src/lib/api.ts";
import { setupAdmin } from "../auth/accounts.ts";
import { login } from "../auth/sessions.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  artwork,
  files,
  items,
  providerIds,
  versions,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { insertItem } from "../db/tree.ts";
import { startThalia } from "../index.ts";
import { listJobs } from "../jobs/queue.ts";
import { addRoot, insertLibraries } from "../libraries/testing.ts";
import { withFolder } from "../plugins/testing.ts";
import { browser, openPage, signIn, webBuild } from "./browser-testing.ts";
import { publishEvent } from "./events.ts";

const clickButton = (label: string, scope = "document") =>
  `[...${scope}.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)})?.click()`;

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
            // The backdrop page must load while the first request stays held:
            // closing the opening aborts its requests so the queue moves on.
            await page.waitFor(
              "[...document.querySelectorAll('[data-slot=dialog-content] a')].length === 1",
            );
            const titles = await page.eval<string[]>(
              "[...document.querySelectorAll('[data-slot=dialog-content] a')].map(a => a.textContent.trim())",
            );
            expect(titles).toEqual(["Both Gaps"]);

            // Releasing the held request changes nothing: it was aborted.
            await page
              .send("Fetch.continueRequest", {
                requestId: held[0]?.requestId,
              })
              .catch(() => undefined);
            await Bun.sleep(400);
            expect(
              await page.eval<string[]>(
                "[...document.querySelectorAll('[data-slot=dialog-content] a')].map(a => a.textContent.trim())",
              ),
            ).toEqual(["Both Gaps"]);
          } finally {
            await page.close();
            await server.stop();
          }
        }),
      ));
    /** Seeds 25 movies missing their poster and returns the library. */
    async function seedGapLibrary(
      db: import("../db/client.ts").Database,
      folder: string,
    ) {
      const [library] = await insertLibraries(db, {
        name: "Movies",
        medium: "movies",
        rootPath: folder,
      });
      if (library === undefined) throw new Error("Fixture missing.");
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
      return library;
    }

    async function seedAdmin(
      db: import("../db/client.ts").Database,
      deviceId: string,
    ) {
      await setupAdmin(db, { username: "admin", password: "admin-pass" });
      const { token } = await login(
        db,
        {
          username: "admin",
          password: "admin-pass",
          clientName: "Thalia Web",
          deviceId,
          deviceName: "Chromium",
        },
        "127.0.0.1",
      );
      return token;
    }

    const dialogTitles =
      "[...document.querySelectorAll('[data-slot=dialog-content] a')].map(a => a.textContent.trim())";
    const showMorePresent =
      "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Show more')";

    async function waitForHeld(held: unknown[]) {
      const deadline = Date.now() + 20_000;
      while (held.length === 0 && Date.now() < deadline) await Bun.sleep(20);
      if (held.length === 0) throw new Error("No request was held.");
    }

    test("a Show more queued behind a reconcile does not append page one", () =>
      withFolder((folder) =>
        withDatabase(async (db, url) => {
          if (browser === undefined) throw new Error("Expected a browser.");
          await migrateDatabase(db);
          const token = await seedAdmin(db, "overview-browser-serial");
          const library = await seedGapLibrary(db, folder);
          const server = await startThalia("api", {
            databaseUrl: url,
            port: 0,
            pluginOptions: { directory: `${folder}/installed` },
          });
          const page = await openPage();
          const exceptions: string[] = [];
          try {
            const base = `http://127.0.0.1:${server.apiServer?.port}`;
            await signIn(page, base, token, "/admin/overview");
            page.on("Runtime.exceptionThrown", (e: unknown) =>
              exceptions.push(JSON.stringify(e)),
            );
            await page.waitFor(
              "[...document.querySelectorAll('button')].some(b => b.textContent.includes('No poster'))",
            );
            await page.eval(
              "[...document.querySelectorAll('button')].find(b => b.textContent.includes('No poster'))?.click()",
            );
            await page.waitFor(
              "document.querySelectorAll('[data-slot=dialog-content] a').length === 24",
            );
            await page.waitFor(showMorePresent);

            // Hold the reconcile's request; Show more queues behind it.
            const held: { requestId: string }[] = [];
            await page.send("Fetch.enable", {
              patterns: [
                { urlPattern: "*metadataGapItems*", requestStage: "Request" },
              ],
            });
            page.on("Fetch.requestPaused", (p: { requestId: string }) =>
              held.push({ requestId: p.requestId }),
            );
            await publishEvent(db, {
              kind: "library.changed",
              libraryId: library.id,
            });
            await waitForHeld(held);
            await page.eval(clickButton("Show more"));

            // The reconcile completes; the queued Show more must no-op on the
            // now-null cursor rather than re-append page one.
            for (const { requestId } of held)
              await page.send("Fetch.continueRequest", { requestId });
            await page.waitFor(
              "document.querySelectorAll('[data-slot=dialog-content] a').length === 25",
            );
            await Bun.sleep(500);
            const titles = await page.eval<string[]>(dialogTitles);
            expect(new Set(titles).size).toBe(25);
            expect(titles).toHaveLength(25);
            expect(await page.eval<boolean>(showMorePresent)).toBe(false);
            expect(exceptions).toEqual([]);
          } finally {
            await page.close();
            await server.stop();
          }
        }),
      ));

    test("a Try again queued behind a reconcile retries the current cursor", () =>
      withFolder((folder) =>
        withDatabase(async (db, url) => {
          if (browser === undefined) throw new Error("Expected a browser.");
          await migrateDatabase(db);
          const token = await seedAdmin(db, "overview-browser-retry2");
          const library = await seedGapLibrary(db, folder);
          const server = await startThalia("api", {
            databaseUrl: url,
            port: 0,
            pluginOptions: { directory: `${folder}/installed` },
          });
          const page = await openPage();
          const exceptions: string[] = [];
          try {
            const base = `http://127.0.0.1:${server.apiServer?.port}`;
            await signIn(page, base, token, "/admin/overview");
            page.on("Runtime.exceptionThrown", (e: unknown) =>
              exceptions.push(JSON.stringify(e)),
            );
            await page.waitFor(
              "[...document.querySelectorAll('button')].some(b => b.textContent.includes('No poster'))",
            );
            await page.eval(
              "[...document.querySelectorAll('button')].find(b => b.textContent.includes('No poster'))?.click()",
            );
            await page.waitFor(
              "document.querySelectorAll('[data-slot=dialog-content] a').length === 24",
            );

            // Fail the Show more request; hold whatever comes after.
            const held: { requestId: string }[] = [];
            let failedOnce = false;
            await page.send("Fetch.enable", {
              patterns: [
                { urlPattern: "*metadataGapItems*", requestStage: "Request" },
              ],
            });
            page.on("Fetch.requestPaused", (p: { requestId: string }) => {
              if (!failedOnce) {
                failedOnce = true;
                void page.send("Fetch.failRequest", {
                  requestId: p.requestId,
                  errorReason: "Failed",
                });
                return;
              }
              held.push({ requestId: p.requestId });
            });
            await page.eval(clickButton("Show more"));
            await page.waitFor(
              "[...document.querySelectorAll('[data-slot=dialog-content] button')].some(b => b.textContent.trim() === 'Try again')",
            );

            // Hold the reconcile; Try again queues behind it.
            await publishEvent(db, {
              kind: "library.changed",
              libraryId: library.id,
            });
            await waitForHeld(held);
            await page.eval(
              clickButton(
                "Try again",
                "document.querySelector('[data-slot=dialog-content]')",
              ),
            );
            for (const { requestId } of held)
              await page.send("Fetch.continueRequest", { requestId });
            await page.send("Fetch.disable");

            // The reconcile lands all 25; the queued retry sees the null
            // cursor and does not append anything.
            await page.waitFor(
              "document.querySelectorAll('[data-slot=dialog-content] a').length === 25",
            );
            await Bun.sleep(500);
            const titles = await page.eval<string[]>(dialogTitles);
            expect(new Set(titles).size).toBe(25);
            expect(titles).toHaveLength(25);
            expect(await page.eval<boolean>(showMorePresent)).toBe(false);
            expect(
              await page.eval<boolean>(
                "[...document.querySelectorAll('[data-slot=dialog-content] button')].every(b => b.textContent.trim() !== 'Try again')",
              ),
            ).toBe(true);
            expect(exceptions).toEqual([]);
          } finally {
            await page.close();
            await server.stop();
          }
        }),
      ));

    test("a failed reconcile keeps its rows and Try again refetches cleanly", () =>
      withFolder((folder) =>
        withDatabase(async (db, url) => {
          if (browser === undefined) throw new Error("Expected a browser.");
          await migrateDatabase(db);
          const token = await seedAdmin(db, "overview-browser-retry");
          const library = await seedGapLibrary(db, folder);
          const server = await startThalia("api", {
            databaseUrl: url,
            port: 0,
            pluginOptions: { directory: `${folder}/installed` },
          });
          const page = await openPage();
          const exceptions: string[] = [];
          try {
            const base = `http://127.0.0.1:${server.apiServer?.port}`;
            await signIn(page, base, token, "/admin/overview");
            page.on("Runtime.exceptionThrown", (e: unknown) =>
              exceptions.push(JSON.stringify(e)),
            );
            await page.waitFor(
              "[...document.querySelectorAll('button')].some(b => b.textContent.includes('No poster'))",
            );
            await page.eval(
              "[...document.querySelectorAll('button')].find(b => b.textContent.includes('No poster'))?.click()",
            );
            await page.waitFor(
              "document.querySelectorAll('[data-slot=dialog-content] a').length === 24",
            );
            await page.eval(clickButton("Show more"));
            await page.waitFor(
              "document.querySelectorAll('[data-slot=dialog-content] a').length === 25",
            );

            // Fail the reconcile's request.
            await page.send("Fetch.enable", {
              patterns: [
                { urlPattern: "*metadataGapItems*", requestStage: "Request" },
              ],
            });
            page.on(
              "Fetch.requestPaused",
              (p: { requestId: string }) =>
                void page.send("Fetch.failRequest", {
                  requestId: p.requestId,
                  errorReason: "Failed",
                }),
            );
            await publishEvent(db, {
              kind: "library.changed",
              libraryId: library.id,
            });

            // The 25 rows stay; the failure and Try again appear.
            await page.waitFor(
              "[...document.querySelectorAll('[data-slot=dialog-content] button')].some(b => b.textContent.trim() === 'Try again')",
            );
            expect(await page.eval<string[]>(dialogTitles)).toHaveLength(25);

            // Requests flow again; Try again reruns the reconcile.
            await page.send("Fetch.disable");
            await page.eval(
              clickButton(
                "Try again",
                "document.querySelector('[data-slot=dialog-content]')",
              ),
            );
            await page.waitFor(
              "[...document.querySelectorAll('[data-slot=dialog-content] button')].every(b => b.textContent.trim() !== 'Try again')",
            );
            await Bun.sleep(300);
            const titles = await page.eval<string[]>(dialogTitles);
            expect(new Set(titles).size).toBe(25);
            expect(titles).toHaveLength(25);
            expect(exceptions).toEqual([]);
          } finally {
            await page.close();
            await server.stop();
          }
        }),
      ));

    test(
      "deleting a Library drops its counts from the Media totals",
      () =>
        withFolder((folder) =>
          withDatabase(async (db, url) => {
            if (browser === undefined) throw new Error("Expected a browser.");
            await migrateDatabase(db);
            const token = await seedAdmin(db, "overview-browser-delete");
            const movieDir = join(folder, "movies");
            const showDir = join(folder, "shows");
            await mkdir(movieDir);
            await mkdir(showDir);
            const [movies, shows] = await insertLibraries(db, [
              { name: "Films", medium: "movies", rootPath: movieDir },
              { name: "TV", medium: "shows", rootPath: showDir },
            ]);
            if (!movies || !shows) throw new Error("Fixture missing.");
            await insertItem(db, {
              libraryId: movies.id,
              kind: "movie",
              title: "Dune",
              canonicalFolder: "dune",
              extension: {},
            });
            const server = await startThalia("api", {
              databaseUrl: url,
              port: 0,
            });
            const page = await openPage();
            try {
              const base = `http://127.0.0.1:${server.apiServer?.port}`;
              const api = createThaliaClient({
                origin: base,
                headers: { authorization: `Bearer ${token}` },
              });
              const mediaText = `(() => {
              const section = [...document.querySelectorAll('h2')]
                .find(e => e.textContent.trim() === 'Media')
                ?.closest('section');
              return section?.innerText ?? '';
            })()`;
              await signIn(page, base, token, "/admin");
              await page.waitFor(`(${mediaText}).includes('Movies')`);
              await api.libraries.delete({ id: movies.id });
              // The library-list poll notices the id change and refetches all.
              await page.waitFor(
                `!document.body.innerText.includes('Films')`,
                30_000,
              );
              expect(
                await page.eval<boolean>(`(${mediaText}).includes('Movies')`),
              ).toBe(false);
              // The Shows row stays: a shows Library still exists with 0 shows.
              expect(
                await page.eval<boolean>(`(${mediaText}).includes('Shows')`),
              ).toBe(true);
            } finally {
              await page.close();
              await server.stop();
            }
          }),
        ),
      60_000,
    );

    test(
      "a library.changed event refreshes the library page's gap counts",
      () =>
        withFolder((folder) =>
          withDatabase(async (db, url) => {
            if (browser === undefined) throw new Error("Expected a browser.");
            await migrateDatabase(db);
            const token = await seedAdmin(db, "overview-browser-libgaps");
            await mkdir(join(folder, "root"));
            const [library] = await insertLibraries(db, {
              name: "TV",
              medium: "shows",
              rootPath: join(folder, "root"),
            });
            if (library === undefined) throw new Error("Fixture missing.");
            const show = await insertItem(db, {
              libraryId: library.id,
              kind: "show",
              title: "Series",
              canonicalFolder: "series",
              extension: {},
            });
            await insertItem(db, {
              libraryId: library.id,
              kind: "season",
              parentId: show.id,
              title: "Season 1",
              canonicalFolder: "series/s1",
              extension: { seasonNumber: 1 },
            });
            const server = await startThalia("api", {
              databaseUrl: url,
              port: 0,
            });
            const page = await openPage();
            try {
              const base = `http://127.0.0.1:${server.apiServer?.port}`;
              await signIn(page, base, token, `/admin/libraries/${library.id}`);
              // The show misses everything; only the overview row matters here.
              await page.waitFor(
                "[...document.querySelectorAll('button')].some(b => b.textContent.includes('No overview'))",
              );
              await db
                .update(items)
                .set({ overview: "Found later." })
                .where(eq(items.id, show.id));
              await publishEvent(db, {
                kind: "library.changed",
                libraryId: library.id,
              });
              await page.waitFor(
                "[...document.querySelectorAll('button')].every(b => !b.textContent.includes('No overview'))",
              );
            } finally {
              await page.close();
              await server.stop();
            }
          }),
        ),
      60_000,
    );

    test(
      "removing a folder updates the library page's free space",
      () =>
        withFolder((folder) =>
          withDatabase(async (db, url) => {
            if (browser === undefined) throw new Error("Expected a browser.");
            await migrateDatabase(db);
            const token = await seedAdmin(db, "overview-browser-roots");
            const dirA = join(folder, "a");
            const dirB = join(folder, "b");
            await mkdir(dirA);
            await mkdir(dirB);
            const [library] = await insertLibraries(db, {
              name: "Movies",
              medium: "movies",
              rootPath: dirA,
            });
            if (library === undefined) throw new Error("Fixture missing.");
            const rootB = await addRoot(db, library.id, dirB);
            const movie = await insertItem(db, {
              libraryId: library.id,
              kind: "movie",
              title: "Dune",
              canonicalFolder: "dune",
              extension: {},
            });
            for (const [rootId, bytes] of [
              [library.rootId, 1_500_000_000n],
              [rootB, 900_000_000n],
            ] as const) {
              const [version] = await db
                .insert(versions)
                .values({
                  itemId: movie.id,
                  itemKind: "movie",
                  libraryId: library.id,
                  label: "Original",
                  format: "video",
                  bytes,
                  durationSeconds: 7000,
                })
                .returning();
              if (!version) throw new Error("Version insert returned no row.");
              await db.insert(files).values({
                versionId: version.id,
                itemId: movie.id,
                libraryId: library.id,
                rootId,
                path: `/${version.id}.mkv`,
                order: 0,
                bytes,
                modifiedAt: new Date(),
              });
            }
            const server = await startThalia("api", {
              databaseUrl: url,
              port: 0,
            });
            const page = await openPage();
            try {
              const base = `http://127.0.0.1:${server.apiServer?.port}`;
              await signIn(page, base, token, `/admin/libraries/${library.id}`);
              await page.waitFor("document.body.innerText.includes('2.4 GB')");
              await page.eval(
                `document.querySelector(${JSON.stringify(`button[aria-label="Remove ${dirB}"]`)}).click()`,
              );
              await page.waitFor(
                "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Remove folder')",
              );
              await page.eval(clickButton("Remove folder"));
              await page.waitFor(
                "document.body.innerText.includes('1.5 GB') && !document.body.innerText.includes('2.4 GB')",
              );
            } finally {
              await page.close();
              await server.stop();
            }
          }),
        ),
      60_000,
    );

    test(
      "a failing free-space load shows Try again and recovers",
      () =>
        withFolder((folder) =>
          withDatabase(async (db, url) => {
            if (browser === undefined) throw new Error("Expected a browser.");
            await migrateDatabase(db);
            const token = await seedAdmin(db, "overview-browser-spacefail");
            await mkdir(join(folder, "root"));
            const [library] = await insertLibraries(db, {
              name: "Movies",
              medium: "movies",
              rootPath: join(folder, "root"),
            });
            if (library === undefined) throw new Error("Fixture missing.");
            const server = await startThalia("api", {
              databaseUrl: url,
              port: 0,
            });
            const page = await openPage();
            try {
              const base = `http://127.0.0.1:${server.apiServer?.port}`;
              await page.send("Fetch.enable", {
                patterns: [
                  { urlPattern: "*freeSpace*", requestStage: "Request" },
                ],
              });
              page.on(
                "Fetch.requestPaused",
                (p: { requestId: string }) =>
                  void page.send("Fetch.failRequest", {
                    requestId: p.requestId,
                    errorReason: "ConnectionFailed",
                  }),
              );
              await signIn(page, base, token, `/admin/libraries/${library.id}`);
              await page.waitFor(
                "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Try again')",
              );
              await page.send("Fetch.disable");
              await page.eval(clickButton("Try again"));
              await page.waitFor("document.body.innerText.includes('free of')");
            } finally {
              await page.close();
              await server.stop();
            }
          }),
        ),
      60_000,
    );
  },
);
