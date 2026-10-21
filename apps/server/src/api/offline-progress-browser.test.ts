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

describe.skipIf(!databaseUrl || browser === undefined)(
  "offline progress",
  () => {
    test(
      "progress queued offline survives a reload and reaches the server once it is back",
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
            await signIn(page, base, token, "/downloads");
            await page.waitFor("navigator.serviceWorker.controller !== null");
            await server.stop();
            server = undefined;

            // What offline playback leaves: the end of the movie, a minute ago.
            const at = new Date(Date.now() - 60_000).toISOString();
            await page.eval(
              `localStorage.setItem('thalia.offline-progress', ${JSON.stringify(
                JSON.stringify([
                  {
                    userId: viewer.id,
                    itemId,
                    versionId,
                    positionSeconds: 4,
                    completed: true,
                    at,
                  },
                ]),
              )})`,
            );
            // A fresh load, so the wait below can't pass on the old page.
            await page.goto(`${base}/downloads`);
            await page.waitFor(
              "document.querySelector('h1')?.textContent === 'Downloads'",
            );
            await Bun.sleep(1000);
            expect(await page.eval<string>(queued)).toContain(versionId);

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
            expect(row).toMatchObject({
              versionId,
              positionSeconds: 4,
              completed: true,
              updatedAt: new Date(at),
            });
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
