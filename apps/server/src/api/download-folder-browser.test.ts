import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { login } from "../auth/sessions.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startThalia } from "../index.ts";
import { scanDirectory } from "../libraries/scan.ts";
import { createLibrary } from "../libraries/service.ts";
import { createVideoFixture } from "../mediums/video-common/fixtures.ts";
import { browser, openPage, signIn, webBuild } from "./browser-testing.ts";

const byLabel = (label: string) =>
  `[...document.querySelectorAll('button, a')].some(b => (b.getAttribute('aria-label') ?? '') === ${JSON.stringify(label)})`;
const clickLabel = (label: string) =>
  `[...document.querySelectorAll('button, a')].find(b => (b.getAttribute('aria-label') ?? '') === ${JSON.stringify(label)})?.click()`;
const clickText = (text: string) =>
  `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})?.click()`;
const hasText = (text: string) =>
  `document.querySelector('main')?.innerText.includes(${JSON.stringify(text)})`;
/** Names and sizes of the files in an OPFS folder. */
const listing = (folder: string) => `(async () => {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(${JSON.stringify(folder)}, { create: true });
  const files = {};
  for await (const [name, handle] of dir.entries())
    if (handle.kind === "file") files[name] = (await handle.getFile()).size;
  return files;
})()`;

// Headless Chromium can't drive the real picker, so it hands out an OPFS
// folder: a FileSystemDirectoryHandle like any picked folder, already granted.
const standInPicker = `window.showDirectoryPicker = async () =>
  (await navigator.storage.getDirectory()).getDirectoryHandle("disk", { create: true });`;

describe.skipIf(!databaseUrl || browser === undefined)(
  "download folder",
  () => {
    test(
      "a linked folder takes finished downloads, outlives the session, lists its downloads afresh and plays offline",
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
              deviceId: "download-folder",
              deviceName: "Chromium",
            },
            "127.0.0.1",
          );
          const root = await mkdtemp(join(tmpdir(), "thalia-folder-"));
          let server: Awaited<ReturnType<typeof startThalia>> | undefined;
          const page = await openPage();
          try {
            const movie = join(root, "Arrival (2016)", "Arrival.mkv");
            await mkdir(join(root, "Arrival (2016)"));
            await createVideoFixture(movie, {
              width: 640,
              height: 360,
              durationSeconds: 2,
              frameRate: 25,
              gopSeconds: 1,
            });
            const size = Bun.file(movie).size;
            const library = await createLibrary(db, admin.id, {
              name: "Movies",
              medium: "movies",
              roots: [root],
            });
            const scanned = await scanDirectory(
              db,
              library.id,
              "Arrival (2016)",
            );
            const itemId = scanned.itemId;
            const versionId = scanned.versionIds[0];
            if (itemId === null || versionId === undefined)
              throw new Error("Expected one Item and Version.");

            const picker = await page.send(
              "Page.addScriptToEvaluateOnNewDocument",
              { source: standInPicker },
            );
            server = await startThalia("api", { databaseUrl: url, port: 0 });
            const base = `http://127.0.0.1:${server.apiServer?.port}`;
            await signIn(page, base, token, "/downloads");
            await page.waitFor("navigator.serviceWorker.controller !== null");
            await page.waitFor(hasText("Choose folder"));
            await page.eval(clickText("Choose folder"));
            await page.waitFor(hasText("Unlink"));

            await page.goto(`${base}/movies/${itemId}`);
            await page.waitFor(byLabel("Download"), 30_000);
            await page.eval(clickLabel("Download"));
            // Stay until the finished file has moved into the folder.
            const deadline = Date.now() + 30_000;
            while (
              (await page.eval<Record<string, number>>(listing("disk")))[
                "Arrival (2016).mkv"
              ] !== size
            ) {
              if (Date.now() > deadline)
                throw new Error("The download never reached the folder.");
              await Bun.sleep(150);
            }
            await page.goto(`${base}/downloads`);
            await page.waitFor(hasText("In disk"), 30_000);
            expect(await page.eval(listing("disk"))).toEqual({
              "Arrival (2016).mkv": size,
            });
            expect(await page.eval(listing("downloads"))).toEqual({
              "index.json": expect.any(Number),
            });

            // A later session without this browser's own list still finds
            // the download through the folder's manifest, and opens it offline.
            await page.eval(`(async () => {
              const root = await navigator.storage.getDirectory();
              await (await root.getDirectoryHandle("downloads")).removeEntry("index.json");
            })()`);
            await server.stop();
            server = undefined;
            await page.send("Page.reload", {});
            await page.waitFor(hasText("In disk"), 30_000);
            await page.goto(`${base}/movies/${itemId}`);
            await page.waitFor("document.title === 'Arrival · Thalia'", 30_000);

            await page.goto(`${base}/downloads`);
            await page.waitFor(byLabel("Move to browser storage"), 30_000);
            await page.eval(clickLabel("Move to browser storage"));
            await page.waitFor(byLabel("Move to folder"), 30_000);
            expect(await page.eval(listing("disk"))).toEqual({});
            expect(await page.eval(listing("downloads"))).toMatchObject({
              [versionId]: size,
            });

            // Browsers without the picker don't offer a folder.
            await page.send("Page.removeScriptToEvaluateOnNewDocument", {
              identifier: (picker as { identifier?: string }).identifier,
            });
            await page.send("Page.addScriptToEvaluateOnNewDocument", {
              source: "delete window.showDirectoryPicker;",
            });
            await page.send("Page.reload", {});
            // The usage row and the folder row render together.
            await page.waitFor(hasText("available"), 30_000);
            expect(
              await page.eval<string>("document.body.innerText"),
            ).not.toContain("Download folder");
          } finally {
            await page.close();
            await server?.stop();
            await rm(root, { recursive: true, force: true });
          }
        }),
      180_000,
    );
  },
);
