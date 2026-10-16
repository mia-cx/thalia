import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { setupAdmin } from "../auth/accounts.ts";
import { login } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { episodes, progress, sessionRegistry } from "../db/schema/index.ts";
import {
  databaseUrl,
  runQueuedKeyframeIndexes,
  withDatabase,
} from "../db/testing.ts";
import { startThalia } from "../index.ts";
import { scanShowDirectory } from "../libraries/scan.ts";
import { createLibrary } from "../libraries/service.ts";
import { createVideoFixture } from "../mediums/video-common/fixtures.ts";
import { browser, openPage, signIn, webBuild } from "./browser-testing.ts";

if (databaseUrl && browser === undefined)
  console.info(
    "Skipping the next-Episode browser test: no Chromium found; set THALIA_BROWSER.",
  );

const fixtureSeconds = 4;

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await read();
    if (found !== undefined) return found;
    await Bun.sleep(250);
  }
  return undefined;
}

async function completedProgress(db: Database, userId: string, itemId: string) {
  const [row] = await db
    .select()
    .from(progress)
    .where(and(eq(progress.userId, userId), eq(progress.itemId, itemId)));
  return row?.completed ? row : undefined;
}

describe.skipIf(!databaseUrl || browser === undefined)("next Episode", () => {
  test(
    "plays through the end card into the next Episode",
    () =>
      withDatabase(async (db, url) => {
        if (browser === undefined) throw new Error("Expected a Chromium.");
        if (!existsSync(webBuild))
          throw new Error("Build apps/web before this test.");
        const libraryRoot = await mkdtemp(join(tmpdir(), "thalia-next-"));
        const scratchDir = await mkdtemp(
          join(tmpdir(), "thalia-next-scratch-"),
        );
        try {
          await migrateDatabase(db);
          const admin = await setupAdmin(db, {
            username: "admin",
            password: "secret",
          });
          const { token } = await login(
            db,
            {
              username: "admin",
              password: "secret",
              clientName: "Thalia Web",
              deviceId: "next-episode-test",
              deviceName: "Chromium",
            },
            "127.0.0.1",
          );
          const showDir = join(libraryRoot, "Fixture Show", "Season 1");
          await mkdir(showDir, { recursive: true });
          for (const episode of ["S01E01", "S01E02"])
            await createVideoFixture(
              join(showDir, `Fixture Show ${episode}.mkv`),
              {
                width: 1280,
                height: 720,
                durationSeconds: fixtureSeconds,
                frameRate: 25,
                gopSeconds: 2,
              },
            );
          const library = await createLibrary(db, admin.id, {
            name: "Shows",
            medium: "shows",
            roots: [libraryRoot],
          });
          const scanned = await scanShowDirectory(
            db,
            library.id,
            "Fixture Show",
          );
          await runQueuedKeyframeIndexes(db);
          const episodesByNumber = new Map(
            (
              await db
                .select({
                  itemId: episodes.itemId,
                  episodeNumber: episodes.episodeNumber,
                })
                .from(episodes)
            ).map((row) => [row.episodeNumber, row.itemId]),
          );
          const first = episodesByNumber.get(1);
          const second = episodesByNumber.get(2);
          if (first === undefined || second === undefined)
            throw new Error(
              `Expected two Episodes, scanned ${scanned.itemIds.length}.`,
            );
          const server = await startThalia("all", {
            databaseUrl: url,
            port: 0,
            transcoderOptions: { port: 0, scratchDir },
          });
          const api = `http://127.0.0.1:${server.apiServer?.port}`;
          const page = await openPage();
          try {
            await signIn(page, api, token, `/play/${first}`);
            // Click the transport's Play so the trusted gesture starts playback.
            await page.waitFor(
              `(()=>{const el=document.querySelector('button[aria-label="Play"]');if(!el)return false;const r=el.getBoundingClientRect();return r.width>0;})()`,
            );
            const centre = await page.eval<{ x: number; y: number }>(
              `(()=>{const r=document.querySelector('button[aria-label="Play"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
            );
            for (const type of ["mousePressed", "mouseReleased"])
              await page.send("Input.dispatchMouseEvent", {
                type,
                ...centre,
                button: "left",
                clickCount: 1,
              });
            // E1 ends, the end card counts five seconds, E2 plays to its end.
            const moved = await waitFor(async () =>
              (await page.eval<string>("location.pathname")) ===
              `/play/${second}`
                ? true
                : undefined,
            );
            expect(moved).toBe(true);
            await waitFor(() =>
              page.eval<boolean>(
                "document.querySelector('video')?.ended ?? false",
              ),
            );
            const firstProgress = await waitFor(() =>
              completedProgress(db, admin.id, first),
            );
            const secondProgress = await waitFor(() =>
              completedProgress(db, admin.id, second),
            );
            expect(firstProgress?.completed).toBe(true);
            expect(secondProgress?.completed).toBe(true);
            for (const itemId of [first, second]) {
              const sessions = await db
                .select({ id: sessionRegistry.id })
                .from(sessionRegistry)
                .where(eq(sessionRegistry.itemId, itemId));
              expect(sessions).toHaveLength(1);
            }
            expect(await page.eval<string>("location.pathname")).toBe(
              `/play/${second}`,
            );
          } finally {
            await page.close();
            await server.stop();
          }
        } finally {
          await rm(libraryRoot, { recursive: true, force: true });
          await rm(scratchDir, { recursive: true, force: true });
        }
      }),
    180_000,
  );
});
