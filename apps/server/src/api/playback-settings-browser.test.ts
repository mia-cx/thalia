import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { login } from "../auth/sessions.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { userSettings } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startThalia } from "../index.ts";
import { browser, openPage, signIn, webBuild } from "./browser-testing.ts";

describe.skipIf(!databaseUrl || browser === undefined)(
  "playback settings page",
  () => {
    beforeAll(() => {
      if (!existsSync(webBuild))
        throw new Error("Build apps/web before this test.");
    });

    test(
      "a viewer flips Prefer direct stream and it persists",
      () =>
        withDatabase(async (db, url) => {
          if (browser === undefined) throw new Error("Expected a browser.");
          await migrateDatabase(db);
          const admin = await setupAdmin(db, {
            username: "admin",
            password: "admin-pass",
          });
          const viewer = await createLocalUser(db, admin.id, {
            username: "viewer",
            password: "viewer-pass",
            displayName: "Viewer",
          });
          const { token } = await login(
            db,
            {
              username: "viewer",
              password: "viewer-pass",
              clientName: "Thalia Web",
              deviceId: "playback-settings-browser",
              deviceName: "Chromium",
            },
            "127.0.0.1",
          );
          const server = await startThalia("api", {
            databaseUrl: url,
            port: 0,
          });
          const base = `http://127.0.0.1:${server.apiServer?.port}`;
          const page = await openPage();
          try {
            await signIn(page, base, token, "/web/settings/playback");
            await page.waitFor(
              "document.querySelector('#preferDirectStream:not([disabled])') !== null",
            );
            expect(
              await page.eval<string | null>(
                "document.querySelector('#preferDirectStream').getAttribute('aria-checked')",
              ),
            ).toBe("false");
            expect(
              await page.eval<string | null>(
                "document.querySelector('#autoplayNextEpisode').getAttribute('aria-checked')",
              ),
            ).toBe("true");

            await page.eval(
              "document.querySelector('#preferDirectStream').click()",
            );
            // The switch is disabled while its write settles, then shows on.
            await page.waitFor(
              "document.querySelector('#preferDirectStream:not([disabled])') !== null && document.querySelector('#preferDirectStream').getAttribute('aria-checked') === 'true'",
            );

            // A reload shows the saved state.
            await page.goto(`${base}/web/settings/playback`);
            await page.waitFor(
              "document.querySelector('#preferDirectStream:not([disabled])') !== null && document.querySelector('#preferDirectStream').getAttribute('aria-checked') === 'true'",
            );
            const [row] = await db
              .select({ preferDirectStream: userSettings.preferDirectStream })
              .from(userSettings)
              .where(eq(userSettings.userId, viewer.id));
            expect(row?.preferDirectStream).toBe(true);
          } finally {
            await page.close();
            await server.stop();
          }
        }),
      60_000,
    );
  },
);
