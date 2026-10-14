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
  "user admin page",
  () => {
    beforeAll(() => {
      if (!existsSync(webBuild))
        throw new Error("Build apps/web before this test.");
    });

    test(
      "turning on Prefer direct stream saves through the Playback group",
      () =>
        withDatabase(async (db, url) => {
          if (browser === undefined) throw new Error("Expected a browser.");
          await migrateDatabase(db);
          const admin = await setupAdmin(db, {
            username: "admin",
            password: "admin-pass",
          });
          const { token } = await login(
            db,
            {
              username: "admin",
              password: "admin-pass",
              clientName: "Thalia Web",
              deviceId: "users-browser",
              deviceName: "Chromium",
            },
            "127.0.0.1",
          );
          const viewer = await createLocalUser(db, admin.id, {
            username: "viewer",
            password: "viewer-pass",
            displayName: "Viewer",
          });
          const server = await startThalia("api", {
            databaseUrl: url,
            port: 0,
          });
          const base = `http://127.0.0.1:${server.apiServer?.port}`;
          const page = await openPage();
          try {
            await signIn(page, base, token, `/admin/users/${viewer.id}`);
            await page.waitFor(
              "document.querySelector('#preferDirectStream') !== null",
            );
            expect(
              await page.eval<string | null>(
                "document.querySelector('#preferDirectStream').getAttribute('aria-checked')",
              ),
            ).toBe("false");

            await page.eval(
              "document.querySelector('#preferDirectStream').click()",
            );
            await page.eval(
              "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save')?.click()",
            );
            await page.waitFor(
              "document.querySelector('#preferDirectStream').getAttribute('aria-checked') === 'true'",
            );

            // The row landed; a reload shows the saved state.
            await page.goto(`${base}/admin/users/${viewer.id}`);
            await page.waitFor(
              "document.querySelector('#preferDirectStream') !== null",
            );
            expect(
              await page.eval<string | null>(
                "document.querySelector('#preferDirectStream').getAttribute('aria-checked')",
              ),
            ).toBe("true");
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
