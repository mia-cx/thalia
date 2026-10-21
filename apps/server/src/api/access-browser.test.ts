import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createThaliaClient } from "../../../web/src/lib/api.ts";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { createApiKey, login } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { insertItem } from "../db/item-fixtures.ts";
import { accessRules, groups } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startThalia } from "../index.ts";
import { insertLibraries } from "../libraries/testing.ts";
import {
  browser,
  openPage,
  type Page,
  signIn,
  webBuild,
} from "./browser-testing.ts";

const fill = (id: string, value: string) =>
  `(() => { const input = document.getElementById(${JSON.stringify(id)}); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`;

const mouse = async (page: Page, point: { x: number; y: number }) => {
  for (const type of ["mousePressed", "mouseReleased"] as const)
    await page.send("Input.dispatchMouseEvent", {
      type,
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
};

// Bits-ui Selects open on pointerdown, so drive real mouse input.
async function click(page: Page, selector: string, text?: string) {
  const element = `(() => { const els = [...document.querySelectorAll(${JSON.stringify(selector)})]; return ${text === undefined ? "els[0]" : `els.find(e => e.textContent.trim() === ${JSON.stringify(text)})`}; })()`;
  await page.eval(`${element}?.scrollIntoView({ block: "center" })`);
  // Closing a floating layer can restore focus and scroll after it disappears.
  await waitForSettled(page, element);
  const point = await page.eval<{ x: number; y: number }>(
    `(() => { const el = ${element}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  if (point === null) throw new Error(`No ${selector} "${text}".`);
  await mouse(page, point);
}

const optionSelector = "[data-slot=select-item],[data-slot=combobox-item]";

/** Waits until an element's bounding box stops moving between reads. */
async function waitForSettled(page: Page, expression: string) {
  let last = "";
  for (let i = 0; i < 40; i++) {
    const next = await page.eval<string>(
      `(() => { const el = ${expression}; if (!el) return null; const r = el.getBoundingClientRect(); return JSON.stringify([r.x, r.y]); })()`,
    );
    if (next === last) return;
    last = next;
    await Bun.sleep(50);
  }
}

const optionFinder = (label: string) =>
  `[...document.querySelectorAll('${optionSelector}')].find(i => i.textContent.trim().startsWith(${JSON.stringify(label)}))`;

/** Picks an open Select or Combobox option by the start of its text. */
async function pick(page: Page, label: string) {
  await page.waitFor(
    `[...document.querySelectorAll('${optionSelector}')].some(i => i.textContent.trim().startsWith(${JSON.stringify(label)}))`,
  );
  // The floating layer follows its anchor on scroll, so scroll first, let it
  // settle, then measure the option's viewport point.
  await page.eval(
    `(() => { const el = ${optionFinder(label)}; const r = el.getBoundingClientRect(); if (r.bottom < 0 || r.top > innerHeight) window.scrollBy(0, r.top - innerHeight / 2); })()`,
  );
  await waitForSettled(page, optionFinder(label));
  const point = await page.eval<{ x: number; y: number }>(
    `(() => { const el = ${optionFinder(label)}; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: Math.max(4, Math.min(innerHeight - 4, r.y + r.height / 2)) }; })()`,
  );
  await mouse(page, point);
  // The closing animation keeps its layer up briefly; the next click must not hit it.
  await page.waitFor(
    `document.querySelectorAll('${optionSelector}').length === 0`,
  );
}

/** Lists the labels of the currently open Select options. */
async function optionLabels(page: Page) {
  return page.eval<string[]>(
    `[...document.querySelectorAll('[data-slot=select-item]')].map(i => i.textContent.trim())`,
  );
}

/** Types into the object picker's combobox input, replacing its value. */
async function typeObject(page: Page, text: string) {
  await page.eval(
    "document.getElementById('access-object')?.scrollIntoView({ block: 'center' })",
  );
  await waitForSettled(page, "document.getElementById('access-object')");
  await page.eval(fill("access-object", text));
}

/** Clicks the Add rule submit button and returns. */
async function addRule(page: Page) {
  await page.eval(
    "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add rule')?.click()",
  );
}

const removeButtonPresent = (label: string) =>
  `[...document.querySelectorAll('button')].some(b => b.getAttribute('aria-label') === ${JSON.stringify(label)})`;

async function adminSession(db: Database) {
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
      deviceId: "access-browser",
      deviceName: "Chromium",
    },
    "127.0.0.1",
  );
  return { admin, token };
}

async function seedShows(db: Database) {
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
  return { library, showA, showB, showC };
}

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
          const { token } = await adminSession(db);
          const { showA, showB, showC } = await seedShows(db);
          const server = await startThalia("api", {
            databaseUrl: url,
            port: 0,
          });
          const base = `http://127.0.0.1:${server.apiServer?.port}`;
          const page = await openPage();
          try {
            await signIn(page, base, token, "/web/admin/users");
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

            await signIn(page, base, token, `/web/admin/users/${created.id}`);
            await page.waitFor(
              "document.querySelector('#access-object') !== null",
            );
            await typeObject(page, "Server");
            await pick(page, "Server");
            await click(page, "#access-access");
            await pick(page, "Deny");
            await addRule(page);
            await page.waitFor(
              removeButtonPresent("Remove the View rule on the server"),
            );

            // Access stays on Deny from the server rule.
            await click(page, "#access-access");
            await pick(page, "Allow");
            for (const show of [showA, showB]) {
              await typeObject(page, show.title);
              await pick(page, show.title);
              await addRule(page);
              await page.waitFor(
                removeButtonPresent(`Remove the View rule on ${show.title}`),
              );
              expect(
                await page.eval<string>(
                  "document.getElementById('access-object').value",
                ),
              ).toBe("");
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

    test(
      "an admin adds Library and Item rules from a Group page",
      () =>
        withDatabase(async (db, url) => {
          if (browser === undefined) throw new Error("Expected a browser.");
          const { token } = await adminSession(db);
          const { library, showA } = await seedShows(db);
          const server = await startThalia("api", {
            databaseUrl: url,
            port: 0,
          });
          const base = `http://127.0.0.1:${server.apiServer?.port}`;
          const page = await openPage();
          try {
            await signIn(page, base, token, "/web/admin/groups");
            await page.eval(fill("addName", "Family"));
            await page.eval(
              "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Create group')?.click()",
            );
            await page.waitFor(
              "location.pathname.startsWith('/web/admin/groups/')",
            );
            await page.waitFor(
              "document.querySelector('#access-object') !== null",
            );

            // A Library object offers only the object Actions.
            await typeObject(page, "Shows");
            await pick(page, "Shows");
            await click(page, "#access-action");
            expect(await optionLabels(page)).not.toContain("Manage server");
            await pick(page, "View");

            // Editing the picked object's text drops the target.
            await page.eval(
              "(() => { const i = document.getElementById('access-object'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); })()",
            );
            await page.send("Input.insertText", { text: "x" });
            expect(
              await page.eval<string>(
                "document.getElementById('access-object').value",
              ),
            ).toBe("Showsx");
            expect(
              await page.eval<boolean>(
                "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add rule')?.disabled",
              ),
            ).toBe(true);

            // The server object offers every Action.
            await typeObject(page, "Server");
            await pick(page, "Server");
            await click(page, "#access-action");
            expect(await optionLabels(page)).toContain("Manage server");
            await pick(page, "View");

            await typeObject(page, "Shows");
            await pick(page, "Shows");
            await addRule(page);
            await page.waitFor(
              removeButtonPresent("Remove the View rule on Shows"),
            );

            await typeObject(page, "Alpha");
            await pick(page, "Alpha");
            await click(page, "#access-action");
            await pick(page, "Download");
            await click(page, "#access-access");
            await pick(page, "Deny");
            await addRule(page);
            await page.waitFor(
              removeButtonPresent("Remove the Download rule on Alpha"),
            );

            const [family] = await db
              .select({ id: groups.id })
              .from(groups)
              .where(eq(groups.name, "Family"));
            if (!family) throw new Error("The group was not created.");
            const held = (await db.select().from(accessRules)).filter(
              (rule) => rule.groupId === family.id,
            );
            expect(held).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  libraryId: library.id,
                  itemId: null,
                  action: "view",
                  allowed: true,
                }),
                expect.objectContaining({
                  libraryId: null,
                  itemId: showA.id,
                  action: "download",
                  allowed: false,
                }),
              ]),
            );

            await signIn(
              page,
              base,
              token,
              `/web/admin/libraries/${library.id}`,
            );
            await page.waitFor(
              removeButtonPresent("Remove the View rule for Family"),
            );
            // A fixed Library object offers only the object Actions.
            await click(page, "#access-action");
            expect(await optionLabels(page)).not.toContain("Manage server");
            await pick(page, "View");
            await signIn(page, base, token, `/web/shows/${showA.id}`);
            await page.waitFor(
              removeButtonPresent("Remove the Download rule for Family"),
            );
          } finally {
            await page.close();
            await server.stop();
          }
        }),
      60_000,
    );

    test(
      "a restricted account works from the user page alone",
      () =>
        withDatabase(async (db, url) => {
          if (browser === undefined) throw new Error("Expected a browser.");
          const { admin, token } = await adminSession(db);
          const { showA, showB, showC } = await seedShows(db);
          const newbie = await createLocalUser(db, admin.id, {
            username: "newbie",
            password: "newbie-pass",
            displayName: "Newbie",
          });
          const server = await startThalia("api", {
            databaseUrl: url,
            port: 0,
          });
          const base = `http://127.0.0.1:${server.apiServer?.port}`;
          const page = await openPage();
          try {
            await signIn(page, base, token, `/web/admin/users/${newbie.id}`);
            await page.waitFor(
              "document.querySelector('#access-object') !== null",
            );
            expect(
              await page.eval<boolean>(
                "document.body.innerText.includes('Where this user has no rule, their groups decide.')",
              ),
            ).toBe(true);

            await typeObject(page, "Server");
            await pick(page, "Server");
            await click(page, "#access-access");
            await pick(page, "Deny");
            await addRule(page);
            await page.waitFor(
              removeButtonPresent("Remove the View rule on the server"),
            );

            await click(page, "#access-access");
            await pick(page, "Allow");
            for (const show of [showA, showB]) {
              await typeObject(page, show.title);
              await pick(page, show.title);
              await addRule(page);
              await page.waitFor(
                removeButtonPresent(`Remove the View rule on ${show.title}`),
              );
            }

            const { token: newbieToken } = await createApiKey(
              db,
              newbie.id,
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

            await click(
              page,
              `button[aria-label='Remove the View rule on ${showA.title}']`,
            );
            await page.waitFor(
              `!${removeButtonPresent(`Remove the View rule on ${showA.title}`)}`,
            );
            expect(
              (await db.select().from(accessRules)).filter(
                (rule) => rule.userId === newbie.id && rule.itemId === showA.id,
              ),
            ).toEqual([]);
            await expect(api.items.get({ id: showA.id })).rejects.toMatchObject(
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
