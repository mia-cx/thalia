import { describe, expect, test } from "bun:test";
import { createThaliaClient } from "../../../web/src/lib/api.ts";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { createGroup, setPermissionOverride } from "../auth/permissions.ts";
import { createApiKey } from "../auth/sessions.ts";
import { accessRules, items, serverOnlyActions } from "../db/schema/index.ts";
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
      const [item] = await db
        .insert(items)
        .values({
          libraryId: library.id,
          kind: "movie",
          title: "Movie",
          canonicalFolder: ".",
        })
        .returning();
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
});
