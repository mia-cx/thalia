import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createThaliaClient } from "../../../web/src/lib/api.ts";
import { setupAdmin } from "../auth/accounts.ts";
import { createApiKey, login } from "../auth/sessions.ts";
import { insertItem } from "../db/item-fixtures.ts";
import { accessRules } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startThalia } from "../index.ts";
import { insertLibraries } from "../libraries/testing.ts";
import { browser, openPage, signIn, webBuild } from "./browser-testing.ts";

const fill = (id: string, value: string) =>
  `(() => { const input = document.getElementById(${JSON.stringify(id)}); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`;

describe.skipIf(!databaseUrl || browser === undefined)(
  "Access panel in the browser",
  () => {
    beforeAll(() => {
      if (!existsSync(webBuild))
        throw new Error("Build apps/web before this test.");
    });

    test(
      "an admin writes rules that restrict a new account",
      () =>
        withDatabase(async (db, url) => {
          if (browser === undefined) throw new Error("Expected a browser.");
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
              deviceId: "access-browser",
              deviceName: "Chromium",
            },
            "127.0.0.1",
          );
          const [library] = await insertLibraries(db, {
            name: "Shows",
            medium: "shows",
            rootPath: "/srv/shows",
          });
          if (library === undefined) throw new Error("Missing Library.");
          const shows = [];
          for (const title of ["Alpha", "Beta", "Gamma"]) {
            const show = await insertItem(db, {
              libraryId: library.id,
              kind: "show",
              title,
              canonicalFolder: title,
              extension: {},
            });
            shows.push(show);
            const season = await insertItem(db, {
              libraryId: library.id,
              kind: "season",
              title: "Season 1",
              canonicalFolder: title,
              parentId: show.id,
              extension: { seasonNumber: 1 },
            });
            await insertItem(db, {
              withVersion: true,
              libraryId: library.id,
              kind: "episode",
              title: "Episode 1",
              canonicalFolder: title,
              parentId: season.id,
              extension: { episodeNumber: 1 },
            });
          }
          const [showA, showB, showC] = shows;
          if (!showA || !showB || !showC) throw new Error("Missing shows.");
          const server = await startThalia("api", {
            databaseUrl: url,
            port: 0,
          });
          const base = `http://127.0.0.1:${server.apiServer?.port}`;
          const page = await openPage();
          try {
            // Bits-ui Selects open on pointerdown, so drive real mouse input.
            const click = async (selector: string, text?: string) => {
              const point = await page.eval<{ x: number; y: number }>(
                `(() => { const els = [...document.querySelectorAll(${JSON.stringify(selector)})]; const el = ${text === undefined ? "els[0]" : `els.find(e => e.textContent.trim() === ${JSON.stringify(text)})`}; if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
              );
              if (point === null) throw new Error(`No ${selector} "${text}".`);
              for (const type of ["mousePressed", "mouseReleased"] as const)
                await page.send("Input.dispatchMouseEvent", {
                  type,
                  x: point.x,
                  y: point.y,
                  button: "left",
                  clickCount: 1,
                });
            };
            const item = (label: string) =>
              page
                .waitFor(
                  `[...document.querySelectorAll('[data-slot=select-item]')].some(i => i.textContent.trim().startsWith(${JSON.stringify(label)}))`,
                )
                .then(async () => {
                  const point = await page.eval<{ x: number; y: number }>(
                    `(() => { const el = [...document.querySelectorAll('[data-slot=select-item]')].find(i => i.textContent.trim().startsWith(${JSON.stringify(label)})); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
                  );
                  for (const type of ["mousePressed", "mouseReleased"] as const)
                    await page.send("Input.dispatchMouseEvent", {
                      type,
                      x: point.x,
                      y: point.y,
                      button: "left",
                      clickCount: 1,
                    });
                });

            await signIn(page, base, token, "/admin/users");
            await page.eval(fill("addUsername", "newbie"));
            await page.eval(fill("addPassword", "newbie-pass"));
            await page.eval(fill("addDisplayName", "Newbie"));
            await page.eval(
              "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Create account')?.click()",
            );
            await page.waitFor(
              "document.body.innerText.includes('Account created for newbie')",
            );

            const created = await db.query.users.findFirst({
              where: (users, { eq }) => eq(users.username, "newbie"),
            });
            if (!created) throw new Error("The account was not created.");

            await signIn(page, base, token, `/admin/users/${created.id}`);
            await page.waitFor(
              "document.querySelector('#override-view') !== null",
            );
            await click("#override-view");
            await item("Deny");
            await page.waitFor(
              "document.body.innerText.includes('View denied')",
            );

            for (const show of [showA, showB]) {
              await signIn(page, base, token, `/shows/${show.id}`);
              await page.waitFor(
                "document.querySelector('#access-subject') !== null",
              );
              await click("#access-subject");
              await item("Newbie");
              await page.eval(
                "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add rule')?.click()",
              );
              await page.waitFor(
                `[...document.querySelectorAll('button')].some(b => b.getAttribute('aria-label') === 'Remove the View rule for Newbie')`,
              );
            }

            const held = (await db.select().from(accessRules)).filter(
              (rule) => rule.userId === created.id,
            );
            expect(held).toHaveLength(3);
            expect(held).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  itemId: null,
                  action: "view",
                  allowed: false,
                }),
                expect.objectContaining({
                  itemId: showA.id,
                  action: "view",
                  allowed: true,
                }),
                expect.objectContaining({
                  itemId: showB.id,
                  action: "view",
                  allowed: true,
                }),
              ]),
            );

            const { token: newbieToken } = await createApiKey(
              db,
              created.id,
              "newbie",
            );
            const api = createThaliaClient({
              origin: base,
              headers: { authorization: `Bearer ${newbieToken}` },
            });
            expect((await api.items.get({ id: showA.id })).id).toBe(showA.id);
            expect((await api.items.get({ id: showB.id })).id).toBe(showB.id);
            await expect(api.items.get({ id: showC.id })).rejects.toMatchObject(
              {
                code: expect.stringMatching(/^(FORBIDDEN|NOT_FOUND)$/),
              },
            );
          } finally {
            await page.close();
            await server.stop();
          }
        }),
      60_000,
    );
  },
);
