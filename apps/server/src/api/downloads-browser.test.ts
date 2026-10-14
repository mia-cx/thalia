import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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

const fixtureSeconds = 8;

const byLabel = (label: string) =>
  `[...document.querySelectorAll('button, a')].some(b => (b.getAttribute('aria-label') ?? '') === ${JSON.stringify(label)})`;
const byLabelPrefix = (prefix: string) =>
  `[...document.querySelectorAll('button, a')].some(b => (b.getAttribute('aria-label') ?? '').startsWith(${JSON.stringify(prefix)}))`;
const clickLabel = (label: string) =>
  `[...document.querySelectorAll('button, a')].find(b => (b.getAttribute('aria-label') ?? '') === ${JSON.stringify(label)})?.click()`;

describe.skipIf(!databaseUrl || browser === undefined)("web downloads", () => {
  test(
    "a download survives a reload as paused and resumes to identical bytes",
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
        const viewer = await createLocalUser(db, admin.id, {
          username: "viewer",
          password: "viewer-pass",
        });
        const { token } = await login(
          db,
          {
            username: "viewer",
            password: "viewer-pass",
            clientName: "Thalia Web",
            deviceId: "downloads-browser",
            deviceName: "Chromium",
          },
          "127.0.0.1",
        );
        const libraryRoot = await mkdtemp(
          join(tmpdir(), "thalia-downloads-library-"),
        );
        const scratchDir = await mkdtemp(
          join(tmpdir(), "thalia-downloads-scratch-"),
        );
        let server: Awaited<ReturnType<typeof startThalia>> | undefined;
        const page = await openPage();
        try {
          const folder = "Arrival (2016)";
          const file = join(libraryRoot, folder, "Arrival.mkv");
          await mkdir(join(libraryRoot, folder), { recursive: true });
          await createVideoFixture(file, {
            width: 1280,
            height: 720,
            durationSeconds: fixtureSeconds,
            frameRate: 25,
            gopSeconds: 2,
            pattern: "testsrc2",
          });
          const library = await createLibrary(db, admin.id, {
            name: "Movies",
            medium: "movies",
            roots: [libraryRoot],
          });
          const scanned = await scanDirectory(db, library.id, folder);
          const versionId = scanned.versionIds[0];
          if (scanned.itemId === null || versionId === undefined)
            throw new Error("Expected one Item and Version.");
          const itemId = scanned.itemId;
          server = await startThalia("api", { databaseUrl: url, port: 0 });
          const base = `http://127.0.0.1:${server.apiServer?.port}`;

          await signIn(page, base, token, `/movies/${itemId}`);
          await page.waitFor(byLabel("Download"), 30_000);
          // Slow enough that the file is still flowing when the page reloads.
          await page.send("Network.emulateNetworkConditions", {
            offline: false,
            latency: 0,
            downloadThroughput: 20_000,
            uploadThroughput: 1_000_000,
          });
          await page.eval(clickLabel("Download"));
          await page.waitFor(byLabelPrefix("Downloading"), 30_000);
          await page.send("Page.reload", { ignoreCache: true });
          await page.waitFor("document.readyState === 'complete'");

          await page.goto(`${base}/downloads`);
          await page.waitFor(byLabel("Resume download"), 30_000);
          await page.send("Network.emulateNetworkConditions", {
            offline: false,
            latency: 0,
            downloadThroughput: -1,
            uploadThroughput: -1,
          });
          await page.eval(clickLabel("Resume download"));
          await page.waitFor(byLabel("Delete download"), 60_000);

          const opfs = await page.eval<{ hash: string; index: string }>(
            `(async () => {
                const root = await navigator.storage.getDirectory();
                const dir = await root.getDirectoryHandle("downloads");
                const file = await dir.getFileHandle(${JSON.stringify(versionId)});
                const data = await (await file.getFile()).arrayBuffer();
                const digest = await crypto.subtle.digest("SHA-256", data);
                const hash = [...new Uint8Array(digest)]
                  .map((b) => b.toString(16).padStart(2, "0"))
                  .join("");
                const index = await (
                  await dir.getFileHandle("index.json")
                ).getFile();
                return { hash, index: await index.text() };
              })()`,
          );
          const expected = createHash("sha256")
            .update(new Uint8Array(await Bun.file(file).arrayBuffer()))
            .digest("hex");
          expect(opfs.hash).toBe(expected);
          const index = JSON.parse(opfs.index) as {
            versionId: string;
            state: string;
          }[];
          expect(index).toEqual([
            expect.objectContaining({ versionId, state: "complete" }),
          ]);
        } finally {
          await page.close();
          await server?.stop();
          await rm(libraryRoot, { recursive: true, force: true });
          await rm(scratchDir, { recursive: true, force: true });
        }
      }),
    180_000,
  );
});
