import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createThaliaClient } from "../../../web/src/lib/api.ts";
import { server } from "../auth/access.ts";
import { ids, resolverCases } from "../auth/access-cases.ts";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import {
  checkPermission,
  createGroup,
  setPermissionOverride,
  setUserGroups,
} from "../auth/permissions.ts";
import { createApiKey } from "../auth/sessions.ts";
import { insertItem, insertItems } from "../db/item-fixtures.ts";
import { accessRules, serverOnlyActions, users } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startThalia } from "../index.ts";
import { insertLibraries } from "../libraries/testing.ts";

describe.skipIf(!databaseUrl)("Access rule mutations", () => {
  test("RPC and REST write all subject/object types, upsert, and restore inheritance", () =>
    withDatabase(async (db, url) => {
      const admin = await setupAdmin(db, {
        username: "admin",
        password: "admin-pass",
      });
      const viewer = await createLocalUser(db, admin.id, {
        username: "viewer",
        password: "viewer-pass",
      });
      const group = await createGroup(db, admin.id, {
        name: "custom",
        permissions: [],
      });
      const [library] = await insertLibraries(db, {
        name: "Movies",
        medium: "movies",
        rootPath: "/srv/movies",
      });
      if (!library) throw new Error("Missing Library.");
      const [item] = await insertItems(db, {
        libraryId: library.id,
        kind: "movie",
        title: "Movie",
        canonicalFolder: ".",
      });
      if (!item) throw new Error("Missing Item.");
      const { token } = await createApiKey(db, admin.id, "admin");
      const server = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const headers = {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        };
        const client = createThaliaClient({ origin: base, headers });
        for (const subject of [
          { type: "user", id: viewer.id },
          { type: "group", id: group.id },
        ] as const)
          for (const object of [
            { type: "server" },
            { type: "library", id: library.id },
            { type: "item", id: item.id },
          ] as const) {
            const key = { subject, object, action: "download" as const };
            await client.access.setRule({ ...key, allowed: true });
            expect(
              (
                await fetch(`${base}/api/access/rules`, {
                  method: "PUT",
                  headers,
                  body: JSON.stringify({ ...key, allowed: false }),
                })
              ).status,
            ).toBe(200);
            const matching = (await db.select().from(accessRules)).filter(
              (rule) =>
                rule.action === key.action &&
                rule.userId === (subject.type === "user" ? subject.id : null) &&
                rule.groupId ===
                  (subject.type === "group" ? subject.id : null) &&
                rule.libraryId ===
                  (object.type === "library" ? object.id : null) &&
                rule.itemId === (object.type === "item" ? object.id : null),
            );
            expect(matching).toHaveLength(1);
            expect(matching[0]?.allowed).toBe(false);
            await client.access.removeRule(key);
            await client.access.removeRule(key);
          }
        const key = {
          subject: { type: "user" as const, id: viewer.id },
          object: { type: "item" as const, id: item.id },
          action: "view" as const,
        };
        await client.access.setRule({ ...key, allowed: false });
        const removed = await fetch(`${base}/api/access/rules`, {
          method: "DELETE",
          headers,
          body: JSON.stringify(key),
        });
        expect(removed.status).toBe(200);
        expect((await client.items.get({ id: item.id })).id).toBe(item.id);
        expect(
          (await db.select().from(accessRules)).filter(
            (rule) => rule.userId === viewer.id || rule.groupId === group.id,
          ),
        ).toEqual([]);

        for (const object of [
          { type: "library", id: library.id },
          { type: "item", id: item.id },
        ] as const)
          for (const action of serverOnlyActions) {
            const invalid = { subject: key.subject, object, action };
            await expect(
              client.access.setRule({ ...invalid, allowed: true }),
            ).rejects.toMatchObject({ code: "BAD_REQUEST" });
            await expect(
              client.access.removeRule(invalid),
            ).rejects.toMatchObject({ code: "BAD_REQUEST" });
          }
        const missing = {
          ...key,
          object: { type: "item" as const, id: Bun.randomUUIDv7() },
          allowed: true,
        };
        await expect(client.access.setRule(missing)).rejects.toMatchObject({
          code: "NOT_FOUND",
        });

        await setPermissionOverride(
          db,
          admin.id,
          viewer.id,
          "users:manage",
          true,
        );
        const { token: viewerToken } = await createApiKey(
          db,
          viewer.id,
          "manager",
        );
        const manager = createThaliaClient({
          origin: base,
          headers: { authorization: `Bearer ${viewerToken}` },
        });
        await expect(
          manager.access.setRule({ ...key, allowed: true }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(manager.access.removeRule(key)).rejects.toMatchObject({
          code: "FORBIDDEN",
        });
      } finally {
        await server.stop();
      }
    }));

  test("a removed user rule falls back to Groups, and deny wins between Groups", () =>
    withDatabase(async (db, url) => {
      const admin = await setupAdmin(db, {
        username: "admin",
        password: "admin-pass",
      });
      const viewer = await createLocalUser(db, admin.id, {
        username: "viewer",
        password: "viewer-pass",
      });
      const first = await createGroup(db, admin.id, {
        name: "first",
        permissions: [],
      });
      const second = await createGroup(db, admin.id, {
        name: "second",
        permissions: [],
      });
      await setUserGroups(db, admin.id, viewer.id, [first.id, second.id]);
      const { token } = await createApiKey(db, admin.id, "admin");
      const api = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const client = createThaliaClient({
          origin: `http://127.0.0.1:${api.apiServer?.port}`,
          headers: { authorization: `Bearer ${token}` },
        });
        await client.access.setRule({
          subject: { type: "group", id: first.id },
          object: { type: "server" },
          action: "view",
          allowed: true,
        });
        const subject = { type: "user" as const, id: viewer.id };
        const viewKey = {
          subject,
          object: { type: "server" as const },
          action: "view" as const,
        };
        await client.access.setRule({ ...viewKey, allowed: false });
        expect(await checkPermission(db, viewer.id, "view", server)).toBe(
          false,
        );
        await client.access.removeRule(viewKey);
        expect(await checkPermission(db, viewer.id, "view", server)).toBe(true);
        await client.access.setRule({
          subject: { type: "group", id: first.id },
          object: { type: "server" },
          action: "download",
          allowed: true,
        });
        await client.access.setRule({
          subject: { type: "group", id: second.id },
          object: { type: "server" },
          action: "download",
          allowed: false,
        });
        expect(await checkPermission(db, viewer.id, "download", server)).toBe(
          false,
        );
      } finally {
        await api.stop();
      }
    }));
});

describe.skipIf(!databaseUrl)("Access rule reads", () => {
  async function fixture(db: Parameters<typeof setupAdmin>[0], url: string) {
    const admin = await setupAdmin(db, {
      username: "admin",
      password: "admin-pass",
    });
    const viewer = await createLocalUser(db, admin.id, {
      username: "viewer",
      password: "viewer-pass",
    });
    const group = await createGroup(db, admin.id, {
      name: "custom",
      permissions: [],
    });
    const [library] = await insertLibraries(db, {
      name: "Shows",
      medium: "shows",
      rootPath: "/srv/shows",
    });
    if (!library) throw new Error("Missing Library.");
    const show = await insertItem(db, {
      withVersion: true,
      libraryId: library.id,
      kind: "show",
      title: "Show",
      canonicalFolder: ".",
      extension: {},
    });
    const season = await insertItem(db, {
      withVersion: true,
      libraryId: library.id,
      kind: "season",
      parentId: show.id,
      title: "Season 1",
      canonicalFolder: ".",
      extension: { seasonNumber: 1 },
    });
    const episode = await insertItem(db, {
      withVersion: true,
      libraryId: library.id,
      kind: "episode",
      parentId: season.id,
      title: "Episode 1",
      canonicalFolder: ".",
      extension: { episodeNumber: 1 },
    });
    const { token } = await createApiKey(db, admin.id, "admin");
    const { token: viewerToken } = await createApiKey(db, viewer.id, "viewer");
    // Drop the built-in users Group's seeded rules so assertions stay exact.
    await db.delete(accessRules);
    const server = await startThalia("api", { databaseUrl: url, port: 0 });
    const base = `http://127.0.0.1:${server.apiServer?.port}`;
    const client = createThaliaClient({
      origin: base,
      headers: { authorization: `Bearer ${token}` },
    });
    const viewerClient = createThaliaClient({
      origin: base,
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    return {
      admin,
      viewer,
      group,
      library,
      show,
      season,
      episode,
      server,
      base,
      token,
      client,
      viewerClient,
    };
  }

  test("non-admin callers are forbidden", () =>
    withDatabase(async (db, url) => {
      const fx = await fixture(db, url);
      try {
        await expect(
          fx.viewerClient.access.rulesOnObject({
            object: { type: "server" },
          }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(
          fx.viewerClient.access.rulesForSubject({
            subject: { type: "user", id: fx.viewer.id },
          }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
      } finally {
        await fx.server.stop();
      }
    }));

  test("rulesOnObject lists direct rules and the inherited chain", () =>
    withDatabase(async (db, url) => {
      const fx = await fixture(db, url);
      try {
        await fx.client.access.setRule({
          subject: { type: "user", id: fx.viewer.id },
          object: { type: "item", id: fx.episode.id },
          action: "view",
          allowed: true,
        });
        await fx.client.access.setRule({
          subject: { type: "group", id: fx.group.id },
          object: { type: "item", id: fx.season.id },
          action: "play",
          allowed: false,
        });
        await fx.client.access.setRule({
          subject: { type: "user", id: fx.viewer.id },
          object: { type: "item", id: fx.show.id },
          action: "download",
          allowed: true,
        });
        await fx.client.access.setRule({
          subject: { type: "group", id: fx.group.id },
          object: { type: "library", id: fx.library.id },
          action: "view",
          allowed: true,
        });
        await fx.client.access.setRule({
          subject: { type: "user", id: fx.viewer.id },
          object: { type: "server" },
          action: "view",
          allowed: false,
        });
        const { direct, inherited } = await fx.client.access.rulesOnObject({
          object: { type: "item", id: fx.episode.id },
        });
        expect(direct).toEqual([
          {
            subject: { type: "user", id: fx.viewer.id, name: "viewer" },
            object: {
              type: "item",
              id: fx.episode.id,
              name: "Episode 1",
              kind: "episode",
              parentId: fx.season.id,
              showId: fx.show.id,
            },
            action: "view",
            allowed: true,
          },
        ]);
        expect(inherited).toEqual([
          expect.objectContaining({
            object: expect.objectContaining({
              type: "item",
              id: fx.season.id,
              kind: "season",
              parentId: fx.show.id,
              showId: fx.show.id,
            }),
            action: "play",
            allowed: false,
          }),
          expect.objectContaining({
            object: expect.objectContaining({
              type: "item",
              id: fx.show.id,
              kind: "show",
            }),
            action: "download",
          }),
          expect.objectContaining({
            object: { type: "library", id: fx.library.id, name: "Shows" },
            subject: expect.objectContaining({
              type: "group",
              id: fx.group.id,
              name: "custom",
            }),
          }),
          expect.objectContaining({
            object: { type: "server", name: "Server" },
            action: "view",
            allowed: false,
          }),
        ]);
        const libraryResult = await fx.client.access.rulesOnObject({
          object: { type: "library", id: fx.library.id },
        });
        expect(libraryResult.direct).toHaveLength(1);
        expect(libraryResult.inherited.map((rule) => rule.object)).toEqual([
          { type: "server", name: "Server" },
        ]);
        const serverResult = await fx.client.access.rulesOnObject({
          object: { type: "server" },
        });
        expect(serverResult.direct).toHaveLength(1);
        expect(serverResult.inherited).toEqual([]);
        await expect(
          fx.client.access.rulesOnObject({
            object: { type: "item", id: Bun.randomUUIDv7() },
          }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
      } finally {
        await fx.server.stop();
      }
    }));

  test("rulesForSubject lists a subject's rules in object order", () =>
    withDatabase(async (db, url) => {
      const fx = await fixture(db, url);
      try {
        for (const [object, action, allowed] of [
          [{ type: "server" }, "view", false],
          [{ type: "library", id: fx.library.id }, "play", true],
          [{ type: "item", id: fx.show.id }, "download", true],
        ] as const)
          await fx.client.access.setRule({
            subject: { type: "user", id: fx.viewer.id },
            object,
            action,
            allowed,
          });
        await fx.client.access.setRule({
          subject: { type: "group", id: fx.group.id },
          object: { type: "server" },
          action: "view",
          allowed: true,
        });
        const rules = await fx.client.access.rulesForSubject({
          subject: { type: "user", id: fx.viewer.id },
        });
        expect(rules.map((rule) => [rule.object.type, rule.action])).toEqual([
          ["server", "view"],
          ["library", "play"],
          ["item", "download"],
        ]);
        expect(rules[0]?.subject.name).toBe("viewer");
        expect(rules[1]?.object).toMatchObject({ name: "Shows" });
        expect(rules[2]?.object).toMatchObject({
          name: "Show",
          kind: "show",
        });
        const groupRules = await fx.client.access.rulesForSubject({
          subject: { type: "group", id: fx.group.id },
        });
        expect(
          groupRules.map((rule) => [rule.subject.id, rule.object.type]),
        ).toEqual([[fx.group.id, "server"]]);
        await expect(
          fx.client.access.rulesForSubject({
            subject: { type: "user", id: Bun.randomUUIDv7() },
          }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
      } finally {
        await fx.server.stop();
      }
    }));
});

describe.skipIf(!databaseUrl)("Access check explanations", () => {
  // Proves the admin explanation and the enforced check give one answer for every resolver case.
  test("explain matches the real check over the resolver's case table", () =>
    withDatabase(async (db, url) => {
      const admin = await setupAdmin(db, {
        username: "admin",
        password: "admin-pass",
      });
      const viewer = await createLocalUser(db, admin.id, {
        username: "viewer",
        password: "viewer-pass",
      });
      const [group, other, stranger] = await Promise.all(
        ["group", "other", "stranger"].map((name) =>
          createGroup(db, admin.id, { name, permissions: [] }),
        ),
      );
      if (!group || !other || !stranger) throw new Error("Missing Groups.");
      await setUserGroups(db, admin.id, viewer.id, [group.id, other.id]);
      const [library] = await insertLibraries(db, {
        name: "Movies",
        medium: "movies",
        rootPath: "/srv/movies",
      });
      if (!library) throw new Error("Missing Library.");
      const [item, otherItem] = await Promise.all(
        ["Movie", "Other movie"].map((title) =>
          insertItem(db, {
            withVersion: true,
            libraryId: library.id,
            kind: "movie",
            title,
            canonicalFolder: title,
            extension: {},
          }),
        ),
      );
      if (!item || !otherItem) throw new Error("Missing Items.");
      const real: Record<string, string> = {
        [ids.user]: viewer.id,
        [ids.group]: group.id,
        [ids.other]: other.id,
        [ids.stranger]: stranger.id,
        [ids.library]: library.id,
        [ids.item]: item.id,
        [ids.otherItem]: otherItem.id,
      };
      const map = (id: string | null) => (id === null ? null : real[id]);
      const { token } = await createApiKey(db, admin.id, "admin");
      const api = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const client = createThaliaClient({
          origin: `http://127.0.0.1:${api.apiServer?.port}`,
          headers: { authorization: `Bearer ${token}` },
        });
        const object = { type: "item" as const, id: item.id };
        for (const row of resolverCases) {
          await db.delete(accessRules);
          const rules = row.rules.map((rule) => ({
            userId: map(rule.userId),
            groupId: map(rule.groupId),
            libraryId: map(rule.libraryId),
            itemId: map(rule.itemId),
            action: rule.action,
            allowed: rule.allowed,
          }));
          if (rules.length) await db.insert(accessRules).values(rules);
          const winner = row.winner === null ? undefined : rules[row.winner];
          const explanation = await client.access.explain({
            userId: viewer.id,
            object,
            action: row.action,
          });
          expect(
            await checkPermission(db, viewer.id, row.action, object),
            row.name,
          ).toBe(row.allowed);
          expect(explanation, row.name).toMatchObject({
            allowed: row.allowed,
            reason: row.reason,
            rule:
              winner === undefined
                ? null
                : {
                    subject: { id: winner.userId ?? winner.groupId },
                    object: winner.itemId
                      ? { type: "item", id: winner.itemId }
                      : winner.libraryId
                        ? { type: "library", id: winner.libraryId }
                        : { type: "server" },
                    action: winner.action,
                    allowed: winner.allowed,
                  },
          });
        }
      } finally {
        await api.stop();
      }
    }));

  test("explain names the admins bypass and disabled accounts, and only admins may ask", () =>
    withDatabase(async (db, url) => {
      const admin = await setupAdmin(db, {
        username: "admin",
        password: "admin-pass",
      });
      const viewer = await createLocalUser(db, admin.id, {
        username: "viewer",
        password: "viewer-pass",
      });
      const { token } = await createApiKey(db, admin.id, "admin");
      const { token: viewerToken } = await createApiKey(
        db,
        viewer.id,
        "viewer",
      );
      const api = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const origin = `http://127.0.0.1:${api.apiServer?.port}`;
        const client = createThaliaClient({
          origin,
          headers: { authorization: `Bearer ${token}` },
        });
        const viewerClient = createThaliaClient({
          origin,
          headers: { authorization: `Bearer ${viewerToken}` },
        });
        const check = { object: server, action: "server:manage" } as const;
        expect(
          await client.access.explain({ ...check, userId: admin.id }),
        ).toEqual({ allowed: true, reason: "admin", rule: null });
        await expect(
          viewerClient.access.explain({ ...check, userId: viewer.id }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        await db
          .update(users)
          .set({ disabledAt: new Date() })
          .where(eq(users.id, viewer.id));
        expect(
          await client.access.explain({
            object: server,
            action: "view",
            userId: viewer.id,
          }),
        ).toEqual({ allowed: false, reason: "disabled", rule: null });
        await expect(
          client.access.explain({ ...check, userId: Bun.randomUUIDv7() }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
      } finally {
        await api.stop();
      }
    }));
});
