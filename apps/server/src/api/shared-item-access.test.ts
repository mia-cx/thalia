import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { createThaliaClient } from "../../../web/src/lib/api.ts";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { checkPermission, permittedVersionIds } from "../auth/permissions.ts";
import { createApiKey, login } from "../auth/sessions.ts";
import { insertItem } from "../db/item-fixtures.ts";
import {
  accessRules,
  files,
  progress,
  segmentTimelines,
  streams,
  users,
  versions,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startThalia } from "../index.ts";
import { setItemLocation } from "../libraries/locations.ts";
import { insertLibraries } from "../libraries/testing.ts";
import { loadPlaybackSource } from "../playback/planning.ts";
import { loadStoredCandidates, serveStoredHls } from "../stored/playback.ts";
import { subtitleSource } from "../subtitles/service.ts";
import { listVersionViews, listVersionViewsForItems } from "./views.ts";

describe.skipIf(!databaseUrl)("shared Item access", () => {
  // Proves detail and delivery select permitted copies, preserve Item exceptions, and never reveal hidden-copy progress.
  test(
    "each copy follows its own Library, with Item rules taking precedence",
    () =>
      withDatabase(async (db, url) => {
        const folder = await mkdtemp(join(tmpdir(), "thalia-shared-access-"));
        try {
          const admin = await setupAdmin(db, {
            username: "admin",
            password: "admin-pass",
          });
          const viewer = await createLocalUser(db, admin.id, {
            username: "viewer",
            password: "viewer-pass",
          });
          const [a, b] = await insertLibraries(
            db,
            ["a", "b"].map((name) => ({
              name,
              medium: "movies" as const,
              rootPath: join(folder, name),
            })),
          );
          if (!a || !b) throw new Error("Missing Libraries");
          const item = await insertItem(db, {
            libraryId: a.id,
            kind: "movie",
            title: "Shared",
            canonicalFolder: "Film",
            extension: {},
          });
          await setItemLocation(db, item.id, b.rootId, "Other", "");
          const [timeline] = await db
            .insert(segmentTimelines)
            .values({
              itemId: item.id,
              cutKey: "original",
              boundariesSeconds: [0, 4, 8],
            })
            .returning();
          if (!timeline) throw new Error("Missing timeline");
          const copies = [];
          for (const [index, library] of [a, b].entries()) {
            await mkdir(library.rootPath, { recursive: true });
            await Bun.write(join(library.rootPath, "Movie.mkv"), "copy");
            const [version] = await db
              .insert(versions)
              .values({
                itemId: item.id,
                itemKind: "movie",
                libraryId: library.id,
                label: library.name,
                format: "video",
                bytes: 4n,
                durationSeconds: index === 0 ? 8 : 999,
                createdAt: new Date(2020 + index, 0, 1),
                segmentTimelineId: timeline.id,
                timelineAligned: true,
              })
              .returning();
            if (!version) throw new Error("Missing Version");
            const [file] = await db
              .insert(files)
              .values({
                versionId: version.id,
                itemId: item.id,
                libraryId: library.id,
                rootId: library.rootId,
                path: "Movie.mkv",
                order: 0,
                bytes: 4n,
                modifiedAt: new Date(),
                container: "mkv",
              })
              .returning();
            if (!file) throw new Error("Missing File");
            await db.insert(streams).values({
              versionId: version.id,
              fileId: file.id,
              index: 0,
              kind: "video",
              codec: "h264",
              width: 1920,
              height: 1080,
              hdr: "sdr",
            });
            copies.push({ ...version, fileId: file.id });
            for (const action of ["view", "play", "download"] as const)
              await db.insert(accessRules).values({
                userId: viewer.id,
                libraryId: library.id,
                action,
                allowed: index === 0,
              });
          }
          const [first, hidden] = copies;
          if (!first || !hidden) throw new Error("Missing copies");
          const [{ token }, { token: adminToken }] = await Promise.all([
            login(
              db,
              {
                username: "viewer",
                password: "viewer-pass",
                clientName: "Test",
                deviceId: "device",
                deviceName: "Test",
              },
              "127.0.0.1",
            ),
            createApiKey(db, admin.id, "admin"),
          ]);
          const server = await startThalia("api", {
            databaseUrl: url,
            port: 0,
          });
          try {
            const origin = `http://127.0.0.1:${server.apiServer?.port}`;
            const client = createThaliaClient({
              origin,
              headers: { authorization: `Bearer ${token}` },
            });
            const adminClient = createThaliaClient({
              origin,
              headers: { authorization: `Bearer ${adminToken}` },
            });
            const detail = await client.items.get({ id: item.id });
            expect(detail.versions.map((version) => version.id)).toEqual([
              first.id,
            ]);
            expect(detail.versions[0]?.libraryId).toBe(a.id);
            expect(
              (await adminClient.items.get({ id: item.id })).versions,
            ).toHaveLength(2);
            expect(
              (await listVersionViews(db, viewer.id, item.id)).map(
                (version) => version.id,
              ),
            ).toEqual([first.id]);
            expect(
              (await listVersionViewsForItems(db, viewer.id, [item.id]))
                .get(item.id)
                ?.map((version) => version.id),
            ).toEqual([first.id]);
            await expect(
              loadPlaybackSource(db, viewer.id, item.id, hidden.id),
            ).rejects.toMatchObject({ code: "FORBIDDEN" });
            await expect(
              subtitleSource(db, viewer.id, item.id, hidden.id, 0),
            ).rejects.toMatchObject({ code: "NOT_FOUND" });
            expect(
              (
                await fetch(
                  `${origin}/api/items/${item.id}/versions/${hidden.id}/download`,
                  { headers: { cookie: `thalia_session=${token}` } },
                )
              ).status,
            ).toBe(403);

            await db.insert(progress).values({
              userId: viewer.id,
              itemId: item.id,
              versionId: hidden.id,
              format: "video",
              positionSeconds: 2,
              playedAt: new Date(),
            });
            const shelf = await client.shelves.continueWatching({});
            expect(shelf.items[0]?.progress.versionId).toBeNull();
            expect(shelf.items[0]?.durationSeconds).toBe(8);
            expect(
              await (
                await fetch(`${origin}/api/items/${item.id}/progress`, {
                  headers: { authorization: `Bearer ${token}` },
                })
              ).json(),
            ).toMatchObject({ versionId: null });

            const [stored] = await db
              .insert(versions)
              .values({
                itemId: item.id,
                itemKind: "movie",
                libraryId: b.id,
                label: "Stored",
                format: "video",
                bytes: 4n,
                durationSeconds: 8,
                origin: "stored",
                sourceFileId: hidden.fileId,
                storedFolder: "Movie.mkv.thalia/720p",
                rung: "720p",
                complete: true,
                segmentTimelineId: timeline.id,
                timelineAligned: true,
              })
              .returning();
            if (!stored) throw new Error("Missing stored Version");
            await db.insert(streams).values({
              versionId: stored.id,
              fileId: null,
              index: 0,
              kind: "video",
              codec: "h264",
              width: 1280,
              height: 720,
              hdr: "sdr",
              bitrate: 100_000n,
            });
            expect(
              await loadStoredCandidates(db, {
                itemId: item.id,
                fileId: hidden.fileId,
                userId: viewer.id,
              }),
            ).toEqual([]);
            expect(
              (
                await serveStoredHls(
                  db,
                  viewer.id,
                  { itemId: item.id, variantIds: [stored.id] },
                  null,
                  { kind: "master" },
                  "",
                )
              ).status,
            ).toBe(404);

            await db
              .update(accessRules)
              .set({ allowed: false })
              .where(
                and(
                  eq(accessRules.userId, viewer.id),
                  eq(accessRules.libraryId, a.id),
                  eq(accessRules.action, "play"),
                ),
              );
            await db
              .update(accessRules)
              .set({ allowed: true })
              .where(
                and(
                  eq(accessRules.userId, viewer.id),
                  eq(accessRules.libraryId, b.id),
                  eq(accessRules.action, "play"),
                ),
              );
            expect(
              await checkPermission(db, viewer.id, "play", {
                type: "item",
                id: item.id,
              }),
            ).toBe(false);
            expect(
              (
                await fetch(
                  `${origin}/api/items/${item.id}/versions/${first.id}/download`,
                  { headers: { cookie: `thalia_session=${token}` } },
                )
              ).status,
            ).toBe(200);
            await db
              .update(accessRules)
              .set({ allowed: false })
              .where(
                and(
                  eq(accessRules.userId, viewer.id),
                  eq(accessRules.libraryId, a.id),
                  eq(accessRules.action, "view"),
                ),
              );
            await db
              .update(accessRules)
              .set({ allowed: true })
              .where(
                and(
                  eq(accessRules.userId, viewer.id),
                  eq(accessRules.libraryId, b.id),
                  eq(accessRules.action, "view"),
                ),
              );
            expect(
              (await client.items.get({ id: item.id })).versions.map(
                (version) => version.id,
              ),
            ).toEqual([hidden.id]);

            const [rule] = await db
              .insert(accessRules)
              .values({
                userId: viewer.id,
                itemId: item.id,
                action: "view",
                allowed: false,
              })
              .returning();
            if (!rule) throw new Error("Missing rule");
            expect(
              await permittedVersionIds(db, viewer.id, "view", copies),
            ).toEqual(new Set());
            await db
              .update(accessRules)
              .set({ allowed: false })
              .where(
                and(
                  eq(accessRules.userId, viewer.id),
                  eq(accessRules.libraryId, b.id),
                  eq(accessRules.action, "view"),
                ),
              );
            await db
              .update(accessRules)
              .set({ allowed: true })
              .where(eq(accessRules.id, rule.id));
            expect(
              (await client.items.get({ id: item.id })).versions,
            ).toHaveLength(2);
            await db
              .update(users)
              .set({ disabledAt: new Date() })
              .where(eq(users.id, viewer.id));
            expect(
              await permittedVersionIds(db, viewer.id, "view", copies),
            ).toEqual(new Set());
            expect(
              await permittedVersionIds(db, admin.id, "view", copies),
            ).toEqual(new Set(copies.map((version) => version.id)));
          } finally {
            await server.stop();
          }
        } finally {
          await rm(folder, { recursive: true, force: true });
        }
      }),
    20_000,
  );
});
