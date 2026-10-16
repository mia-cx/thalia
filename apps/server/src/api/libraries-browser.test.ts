import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createThaliaClient } from "../../../web/src/lib/api.ts";
import { setupAdmin } from "../auth/accounts.ts";
import { login } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { insertItem } from "../db/item-fixtures.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { artwork } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startThalia } from "../index.ts";
import { addRoot, insertLibraries } from "../libraries/testing.ts";
import { withFolder } from "../plugins/testing.ts";
import { browser, openPage, signIn, webBuild } from "./browser-testing.ts";

type Paused = { requestId: string; url: string; method: string };

const dialogGone =
  "document.querySelector('[data-slot=dialog-content]') === null && document.querySelector('[data-slot=sheet-content]') === null";
const clickButton = (label: string, scope = "document") =>
  `[...${scope}.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)})?.click()`;

/** Runs `withDatabase` with TMDB_API_KEY unset, so only stored keys configure metadata. */
async function withDatabaseWithoutTmdbEnv(
  run: (db: Database, url: string) => Promise<void>,
): Promise<void> {
  const saved = Bun.env.TMDB_API_KEY;
  delete Bun.env.TMDB_API_KEY;
  try {
    await withDatabase(run);
  } finally {
    if (saved === undefined) delete Bun.env.TMDB_API_KEY;
    else Bun.env.TMDB_API_KEY = saved;
  }
}

describe.skipIf(!databaseUrl || browser === undefined)(
  "libraries admin page",
  () => {
    beforeAll(() => {
      if (!existsSync(webBuild))
        throw new Error("Build apps/web before this test.");
    });

    test(
      "a Change opened for one root cannot repoint another root when an earlier removal settles",
      () =>
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
                deviceId: "libraries-browser",
                deviceName: "Chromium",
              },
              "127.0.0.1",
            );
            const dirA = join(folder, "a");
            const dirB = join(folder, "b");
            const dirC = join(folder, "c");
            const repointed = join(folder, "repointed");
            for (const dir of [dirA, dirB, dirC, repointed])
              await mkdir(dir, { recursive: true });
            const [library] = await insertLibraries(db, {
              name: "Movies",
              medium: "movies",
              rootPath: dirA,
            });
            if (library === undefined) throw new Error("Fixture missing.");
            const rootB = await addRoot(db, library.id, dirB);
            const rootC = await addRoot(db, library.id, dirC);
            const server = await startThalia("api", {
              databaseUrl: url,
              port: 0,
              pluginOptions: { directory: join(folder, "installed") },
            });
            const base = `http://127.0.0.1:${server.apiServer?.port}`;
            const api = createThaliaClient({
              origin: base,
              headers: { authorization: `Bearer ${token}` },
            });
            const page = await openPage();
            try {
              await signIn(page, base, token, `/admin/libraries/${library.id}`);
              await page.waitFor(
                `[...document.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Change').length === 3`,
              );

              // Hold library writes; every other request goes through.
              const held: Paused[] = [];
              const seen: Paused[] = [];
              await page.send("Fetch.enable", {
                patterns: [
                  {
                    urlPattern: "*/rpc/libraries/*",
                    requestStage: "Request",
                  },
                ],
              });
              page.on(
                "Fetch.requestPaused",
                (p: {
                  requestId: string;
                  request: { url: string; method: string };
                }) => {
                  const paused = {
                    requestId: p.requestId,
                    url: p.request.url,
                    method: p.request.method,
                  };
                  seen.push(paused);
                  if (paused.url.includes("/update")) held.push(paused);
                  else
                    void page.send("Fetch.continueRequest", {
                      requestId: p.requestId,
                    });
                },
              );

              // Removing A dispatches an update that never lands yet.
              await page.eval(
                `document.querySelector(${JSON.stringify(`button[aria-label="Remove ${dirA}"]`)}).click()`,
              );
              await page.waitFor(
                "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Remove folder')",
              );
              await page.eval(clickButton("Remove folder"));
              await Bun.sleep(600);
              if (held.length !== 1)
                throw new Error(`paused: ${JSON.stringify(seen)}`);
              expect(held.length).toBe(1);
              // Dismiss the confirmation while its write is still held.
              await page.eval(
                `[...document.querySelectorAll('[data-slot=alert-dialog-content] button, [role=alertdialog] button')].find(b => b.textContent.trim() === 'Cancel')?.click()`,
              );

              // Open Change for B and navigate to the new folder.
              await page.waitFor(
                `[...document.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Change').length === 3`,
              );
              await page.eval(
                "[...document.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Change')[1].click()",
              );
              await page.waitFor(
                "document.querySelector('button[aria-label=\"Go to a path\"]')",
              );
              await page.eval(
                "document.querySelector('button[aria-label=\"Go to a path\"]').click()",
              );
              await page.waitFor(
                "document.querySelector('input[aria-label=\"Folder path\"]')",
              );
              await page.eval(
                `(() => { const input = document.querySelector('input[aria-label="Folder path"]'); input.value = ${JSON.stringify(repointed)}; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`,
              );

              // A's removal lands now; B's browser must still write B.
              await page.send("Fetch.continueRequest", {
                requestId: held[0]?.requestId as string,
              });
              await page.waitFor(
                `[...document.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Change').length === 2`,
              );

              await page.waitFor(
                `[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Use folder' && !b.disabled)`,
              );
              await page.eval(clickButton("Use folder"));
              await Bun.sleep(600);
              if (held.length < 2)
                throw new Error("The repoint update never reached the wire.");
              await page.send("Fetch.continueRequest", {
                requestId: held[1]?.requestId as string,
              });

              const deadline = Date.now() + 10_000;
              let paths = new Map<string, string>();
              while (Date.now() < deadline) {
                const answer = await api.libraries.get({ id: library.id });
                paths = new Map(
                  answer.roots.map((root) => [root.id, root.path]),
                );
                if (paths.get(rootB) === repointed) break;
                await Bun.sleep(200);
              }
              expect(paths.get(rootB)).toBe(repointed);
              expect(paths.get(rootC)).toBe(dirC);
              expect(paths.get(library.rootId)).toBeUndefined();
            } finally {
              await page.close();
              await server.stop();
            }
          }),
        ),
      60_000,
    );

    test(
      "the admin says when no metadata source is set up",
      () =>
        withFolder((folder) =>
          withDatabaseWithoutTmdbEnv(async (db, url) => {
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
                deviceId: "libraries-browser-4",
                deviceName: "Chromium",
              },
              "127.0.0.1",
            );
            const server = await startThalia("api", {
              databaseUrl: url,
              port: 0,
              pluginOptions: { directory: join(folder, "installed") },
            });
            const base = `http://127.0.0.1:${server.apiServer?.port}`;
            const api = createThaliaClient({
              origin: base,
              headers: { authorization: `Bearer ${token}` },
            });
            const page = await openPage();
            try {
              await signIn(page, base, token, "/admin/libraries/new");
              await page.waitFor(
                'document.body.innerText.includes("posters and details won\'t load")',
              );
              expect(
                await page.eval<string>(
                  "document.querySelector('.text-footnote a')?.href",
                ),
              ).toMatch(/\/admin\/settings$/);
              expect(
                await page.eval<boolean>(
                  "document.body.innerText.includes('add a TMDB key')",
                ),
              ).toBe(true);
              expect(
                await page.eval<boolean>(
                  "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add library')?.disabled === false",
                ),
              ).toBe(true);

              // Switching Medium to Shows retargets the footnote at TVDB.
              // Bits-ui opens on pointerdown, so drive real mouse input.
              const click = async (selector: string, text?: string) => {
                const point = await page.eval<{ x: number; y: number }>(
                  `(() => { const els = [...document.querySelectorAll(${JSON.stringify(selector)})]; const el = ${text === undefined ? "els[0]" : `els.find(e => e.textContent.trim() === ${JSON.stringify(text)})`}; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
                );
                for (const type of ["mousePressed", "mouseReleased"] as const)
                  await page.send("Input.dispatchMouseEvent", {
                    type,
                    x: point.x,
                    y: point.y,
                    button: "left",
                    clickCount: 1,
                  });
              };
              await click("#libraryMedium");
              await page.waitFor(
                "[...document.querySelectorAll('[data-slot=select-item]')].some(i => i.textContent.trim() === 'Shows')",
              );
              await click("[data-slot=select-item]", "Shows");
              await page.waitFor(
                "document.body.innerText.includes('add a TVDB key')",
              );

              await signIn(page, base, token, "/admin/settings");
              await page.waitFor(
                'document.body.innerText.includes("until you add a key named tmdb for movies or tvdb for shows")',
              );

              await api.settings.setProviderKey({
                name: "tmdb",
                value: "provider-secret-value",
              });
              await signIn(page, base, token, "/admin/settings");
              await page.waitFor(
                'document.body.innerText.includes("until you add a key named tvdb")',
              );
              expect(
                await page.eval<boolean>(
                  "document.body.innerText.includes('No metadata source is set up')",
                ),
              ).toBe(false);

              // Only shows lack a source now, so the footnote follows Medium.
              await signIn(page, base, token, "/admin/libraries/new");
              await click("#libraryMedium");
              await page.waitFor(
                "[...document.querySelectorAll('[data-slot=select-item]')].some(i => i.textContent.trim() === 'Shows')",
              );
              await click("[data-slot=select-item]", "Shows");
              await page.waitFor(
                "document.body.innerText.includes('add a TVDB key')",
              );
              await click("#libraryMedium");
              await page.waitFor(
                "[...document.querySelectorAll('[data-slot=select-item]')].some(i => i.textContent.trim() === 'Movies')",
              );
              await click("[data-slot=select-item]", "Movies");
              await page.waitFor(
                '!document.body.innerText.includes("posters and details won\'t load")',
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
      "closing the folder browser before its listing answers starts no preview",
      () =>
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
                deviceId: "libraries-browser-2",
                deviceName: "Chromium",
              },
              "127.0.0.1",
            );
            const root = join(folder, "media");
            const inside = join(folder, "media", "child");
            await mkdir(inside, { recursive: true });
            const [library] = await insertLibraries(db, {
              name: "Movies",
              medium: "movies",
              rootPath: root,
            });
            if (library === undefined) throw new Error("Fixture missing.");
            const server = await startThalia("api", {
              databaseUrl: url,
              port: 0,
              pluginOptions: { directory: join(folder, "installed") },
            });
            const base = `http://127.0.0.1:${server.apiServer?.port}`;
            const page = await openPage();
            try {
              await signIn(page, base, token, `/admin/libraries/${library.id}`);
              await page.waitFor(
                `[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Change')`,
              );

              // Hold the listing; preview requests only get counted.
              const held: string[] = [];
              const previews: string[] = [];
              const seen: string[] = [];
              await page.send("Fetch.enable", {
                patterns: [
                  {
                    urlPattern: "*/rpc/libraries/*",
                    requestStage: "Request",
                  },
                ],
              });
              page.on(
                "Fetch.requestPaused",
                (p: {
                  requestId: string;
                  request: { url: string; method: string };
                }) => {
                  seen.push(`${p.request.method} ${p.request.url}`);
                  if (p.request.url.includes("/preview")) {
                    previews.push(p.request.url);
                    void page.send("Fetch.continueRequest", {
                      requestId: p.requestId,
                    });
                  } else if (p.request.url.includes("/folders"))
                    held.push(p.requestId);
                  else
                    void page.send("Fetch.continueRequest", {
                      requestId: p.requestId,
                    });
                },
              );

              await page.eval(clickButton("Change"));
              await page.waitFor(
                "document.querySelector('[data-slot=dialog-content], [data-slot=sheet-content]')",
              );
              await Bun.sleep(600);
              expect(held.length).toBe(1);

              // Close before the listing answers, then let it through.
              await page.eval(clickButton("Cancel"));
              await page.waitFor(dialogGone);
              await page.send("Fetch.continueRequest", {
                requestId: held[0] as string,
              });
              await Bun.sleep(1_500);
              if (previews.length !== 0)
                throw new Error(`paused: ${JSON.stringify(seen)}`);
              expect(previews.length).toBe(0);
            } finally {
              await page.close();
              await server.stop();
            }
          }),
        ),
      60_000,
    );

    test(
      "a failed poster image falls back to the printed title without the hover overlay",
      () =>
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
              deviceId: "libraries-browser-3",
              deviceName: "Chromium",
            },
            "127.0.0.1",
          );
          const [library] = await insertLibraries(db, {
            name: "Movies",
            medium: "movies",
            rootPath: "/srv/movies",
          });
          if (library === undefined) throw new Error("Fixture missing.");
          const item = await insertItem(db, {
            libraryId: library.id,
            kind: "movie",
            title: "Poster Fails",
            year: 2001,
            canonicalFolder: "Poster Fails",
            extension: {},
          });
          await db.insert(artwork).values({
            itemId: item.id,
            type: "poster",
            backend: "colocated",
            storageKey: "Poster Fails/poster.jpg",
            selected: true,
          });
          const server = await startThalia("api", {
            databaseUrl: url,
            port: 0,
          });
          const base = `http://127.0.0.1:${server.apiServer?.port}`;
          const page = await openPage();
          try {
            // Every artwork image fails, so the card must render its fallback.
            await page.send("Fetch.enable", {
              patterns: [
                { urlPattern: "*/api/artwork/*", requestStage: "Request" },
              ],
            });
            page.on("Fetch.requestPaused", (p: { requestId: string }) =>
              page.send("Fetch.failRequest", {
                requestId: p.requestId,
                errorReason: "ConnectionFailed",
              }),
            );
            await signIn(page, base, token, "/movies");
            const card = `document.querySelector('a[aria-label^="Poster Fails"]')`;
            await page.waitFor(
              `${card}?.querySelector('.artwork-fallback .text-title-3')?.textContent.includes('Poster Fails')`,
            );

            // Keyboard-focus the card; the overlay must not exist at all.
            for (let i = 0; i < 50; i++) {
              await page.send("Input.dispatchKeyEvent", {
                type: "keyDown",
                key: "Tab",
                code: "Tab",
                windowsVirtualKeyCode: 9,
              });
              await page.send("Input.dispatchKeyEvent", {
                type: "keyUp",
                key: "Tab",
                code: "Tab",
                windowsVirtualKeyCode: 9,
              });
              if (await page.eval(`document.activeElement === ${card}`)) break;
              await Bun.sleep(60);
            }
            expect(
              await page.eval<boolean>(`document.activeElement === ${card}`),
            ).toBe(true);
            await Bun.sleep(600);
            expect(
              await page.eval<boolean>(
                `[...${card}.querySelectorAll('span')].some(s => s.className.includes('h-[45%]'))`,
              ),
            ).toBe(false);
          } finally {
            await page.close();
            await server.stop();
          }
        }),
      60_000,
    );

    test(
      "the phone Menu button yields to Back on item pages",
      () =>
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
              deviceId: "libraries-browser-nav",
              deviceName: "Chromium",
            },
            "127.0.0.1",
          );
          const [library] = await insertLibraries(db, {
            name: "Movies",
            medium: "movies",
            rootPath: "/srv/movies",
          });
          if (library === undefined) throw new Error("Fixture missing.");
          const item = await insertItem(db, {
            libraryId: library.id,
            kind: "movie",
            title: "Onward",
            canonicalFolder: "onward",
            extension: {},
          });
          const server = await startThalia("api", {
            databaseUrl: url,
            port: 0,
          });
          const base = `http://127.0.0.1:${server.apiServer?.port}`;
          const page = await openPage();
          try {
            await page.send("Emulation.setDeviceMetricsOverride", {
              width: 390,
              height: 844,
              deviceScaleFactor: 2,
              mobile: true,
            });
            await signIn(page, base, token, "/movies");
            expect(
              await page.eval<boolean>(
                `document.querySelector('button[aria-label="Menu"]') !== null`,
              ),
            ).toBe(true);

            await page.goto(`${base}/movies/${item.id}`);
            await page.waitFor(
              `document.querySelector('a[aria-label="Back"], button[aria-label="Back"]')`,
            );
            expect(
              await page.eval<boolean>(
                `document.querySelector('button[aria-label="Menu"]') === null`,
              ),
            ).toBe(true);
            expect(
              await page.eval<boolean>(`(() => {
                const back = document.querySelector('[aria-label="Back"]');
                const r = back.getBoundingClientRect();
                const hit = document.elementFromPoint(
                  r.left + r.width / 2,
                  r.top + r.height / 2,
                );
                return hit === back || back.contains(hit);
              })()`),
            ).toBe(true);
          } finally {
            await page.close();
            await server.stop();
          }
        }),
      60_000,
    );
  },
);
