import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { login } from "../auth/sessions.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { progress } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startThalia } from "../index.ts";
import { scanDirectory } from "../libraries/scan.ts";
import { createLibrary } from "../libraries/service.ts";
import { createVideoFixture } from "../mediums/video-common/fixtures.ts";
import { browser, openPage, signIn, webBuild } from "./browser-testing.ts";

const queued = "localStorage.getItem('thalia.offline-progress')";
const video = "document.querySelector('video')";
const byLabel = (label: string) =>
  `[...document.querySelectorAll('button, a')].find(b => b.getAttribute('aria-label') === ${JSON.stringify(label)})`;

describe.skipIf(!databaseUrl || browser === undefined)(
  "offline progress",
  () => {
    test(
      "a download played offline to the end survives a reload and reaches the server once it is back",
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
              deviceId: "offline-progress",
              deviceName: "Chromium",
            },
            "127.0.0.1",
          );
          const root = await mkdtemp(join(tmpdir(), "thalia-offline-p-"));
          let server: Awaited<ReturnType<typeof startThalia>> | undefined;
          const page = await openPage();
          try {
            await mkdir(join(root, "Arrival (2016)"));
            await createVideoFixture(
              join(root, "Arrival (2016)", "Arrival.mkv"),
              {
                width: 640,
                height: 360,
                durationSeconds: 4,
                frameRate: 25,
                gopSeconds: 1,
              },
            );
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

            server = await startThalia("api", { databaseUrl: url, port: 0 });
            const port = server.apiServer?.port;
            const base = `http://127.0.0.1:${port}`;
            await signIn(page, base, token, `/movies/${itemId}`);
            await page.waitFor("navigator.serviceWorker.controller !== null");
            await page.waitFor(byLabel("Download"), 30_000);
            await page.eval(`${byLabel("Download")}.click()`);
            await page.waitFor(byLabel("Downloaded"), 30_000);
            await server.stop();
            server = undefined;

            // Played from the Downloads page with the server down, to the end.
            const playedFrom = Date.now();
            await page.goto(`${base}/downloads`);
            await page.waitFor(byLabel("Play"), 30_000);
            await page.eval(`${byLabel("Play")}.click()`);
            await page.waitFor(`${video}?.readyState >= 2`, 30_000);
            await page.eval(`(() => {
              if (!${video}.paused) return;
              ${byLabel("Play")}?.click();
            })()`);
            await page.waitFor(`${video}.ended`, 30_000);
            // A fresh load, so the wait below can't pass on the old page.
            await page.goto(`${base}/downloads`);
            await page.waitFor(
              "document.querySelector('h1')?.textContent === 'Downloads'",
            );
            await Bun.sleep(1000);
            expect(await page.eval<string>(queued)).toContain(versionId);

            const restartedAt = Date.now();
            server = await startThalia("api", { databaseUrl: url, port });
            await page.waitFor(`${queued} === '[]'`, 30_000);
            const [row] = await db
              .select()
              .from(progress)
              .where(
                and(
                  eq(progress.userId, viewer.id),
                  eq(progress.itemId, itemId),
                ),
              );
            expect(row).toMatchObject({ versionId, completed: true });
            // The end of the 4 s movie, dated when it was watched, not synced.
            expect(row?.positionSeconds).toBeCloseTo(4, 0);
            expect(row?.updatedAt.getTime()).toBeGreaterThanOrEqual(playedFrom);
            expect(row?.updatedAt.getTime()).toBeLessThan(restartedAt);
          } finally {
            await page.close();
            await server?.stop();
            await rm(root, { recursive: true, force: true });
          }
        }),
      120_000,
    );
  },
);
