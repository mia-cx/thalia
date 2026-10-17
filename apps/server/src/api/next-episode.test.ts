import { describe, expect, test } from "bun:test";
import { ORPCError } from "@orpc/client";
import { eq } from "drizzle-orm";
import { createThaliaClient } from "../../../web/src/lib/api.ts";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { setRule } from "../auth/rules.ts";
import { createApiKey } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { insertItem, insertItems } from "../db/item-fixtures.ts";
import { versions } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startThalia } from "../index.ts";
import { insertLibraries } from "../libraries/testing.ts";

async function seed(db: Database) {
  const admin = await setupAdmin(db, {
    username: "admin",
    password: "admin-pass",
  });
  const viewer = await createLocalUser(db, admin.id, {
    username: "viewer",
    password: "viewer-pass",
  });
  const [library] = await insertLibraries(db, {
    name: "Shows",
    medium: "shows",
    rootPath: "/srv/shows",
  });
  if (!library) throw new Error("Missing Library.");
  const show = await insertItem(db, {
    libraryId: library.id,
    kind: "show",
    title: "Show",
    canonicalFolder: ".",
    extension: {},
  });
  const numbered: Record<number, string[]> = {};
  const specials: string[] = [];
  for (const [seasonNumber, count] of [
    [0, 2],
    [1, 2],
    [2, 3],
  ] as const) {
    const season = await insertItem(db, {
      libraryId: library.id,
      kind: "season",
      parentId: show.id,
      title: seasonNumber === 0 ? "Specials" : `Season ${seasonNumber}`,
      canonicalFolder: ".",
      extension: { seasonNumber },
    });
    for (let episodeNumber = 1; episodeNumber <= count; episodeNumber += 1) {
      const episode = await insertItem(db, {
        libraryId: library.id,
        kind: "episode",
        parentId: season.id,
        title: `Episode ${seasonNumber}.${episodeNumber}`,
        canonicalFolder: ".",
        extension: { episodeNumber },
      });
      const [version] = await db
        .insert(versions)
        .values({
          itemId: episode.id,
          itemKind: "episode",
          libraryId: library.id,
          label: "Original",
          format: "video",
          bytes: 13n,
          durationSeconds: 60,
        })
        .returning();
      if (!version) throw new Error("Missing Version.");
      if (seasonNumber === 0) {
        specials.push(episode.id);
      } else {
        const bucket = numbered[seasonNumber] ?? [];
        numbered[seasonNumber] = bucket;
        bucket.push(episode.id);
      }
    }
  }
  const [movie] = await insertItems(db, {
    libraryId: library.id,
    kind: "movie",
    title: "Movie",
    canonicalFolder: ".",
    titleKey: "movie",
    withVersion: true,
  });
  if (!movie) throw new Error("Missing Movie.");
  const { token } = await createApiKey(db, viewer.id, "viewer");
  return { admin, viewer, library, show, numbered, specials, movie, token };
}

function at(ids: string[], index: number): string {
  const id = ids[index];
  if (id === undefined) throw new Error("Missing Episode.");
  return id;
}

async function withShow(
  run: (
    db: Database,
    fx: Awaited<ReturnType<typeof seed>>,
    client: ReturnType<typeof createThaliaClient>,
  ) => Promise<void>,
) {
  await withDatabase(async (db, url) => {
    const fx = await seed(db);
    const server = await startThalia("api", { databaseUrl: url, port: 0 });
    try {
      const client = createThaliaClient({
        origin: `http://127.0.0.1:${server.apiServer?.port}`,
        headers: { authorization: `Bearer ${fx.token}` },
      });
      await run(db, fx, client);
    } finally {
      await server.stop();
    }
  });
}

describe.skipIf(!databaseUrl)("playback.next", () => {
  test("the Season finale crosses into the next Season", () =>
    withShow(async (_db, fx, client) => {
      const next = await client.playback.next({
        itemId: at(fx.numbered[1] ?? [], 1),
      });
      expect(next?.id).toBe(at(fx.numbered[2] ?? [], 0));
      expect(next).toMatchObject({
        seasonNumber: 2,
        episodeNumber: 1,
        title: "Episode 2.1",
        progress: null,
      });
    }));

  test("Specials follow only Specials", () =>
    withShow(async (_db, fx, client) => {
      expect(
        (await client.playback.next({ itemId: at(fx.specials, 0) }))?.id,
      ).toBe(at(fx.specials, 1));
      expect(
        await client.playback.next({ itemId: at(fx.specials, 1) }),
      ).toBeNull();
    }));

  test("a denied Episode is skipped", () =>
    withShow(async (db, fx, client) => {
      await setRule(db, fx.admin.id, {
        subject: { type: "user", id: fx.viewer.id },
        object: { type: "item", id: at(fx.numbered[2] ?? [], 0) },
        action: "view",
        allowed: false,
      });
      expect(
        (await client.playback.next({ itemId: at(fx.numbered[1] ?? [], 1) }))
          ?.id,
      ).toBe(at(fx.numbered[2] ?? [], 1));
    }));

  test("an Episode denied for play is skipped", () =>
    withShow(async (db, fx, client) => {
      await setRule(db, fx.admin.id, {
        subject: { type: "user", id: fx.viewer.id },
        object: { type: "item", id: at(fx.numbered[2] ?? [], 0) },
        action: "play",
        allowed: false,
      });
      expect(
        (await client.playback.next({ itemId: at(fx.numbered[1] ?? [], 1) }))
          ?.id,
      ).toBe(at(fx.numbered[2] ?? [], 1));
    }));

  test("an Episode whose only Version lives in a hidden Library is skipped", () =>
    withShow(async (db, fx, client) => {
      const [restricted] = await insertLibraries(db, {
        name: "Restricted",
        medium: "shows",
        rootPath: "/srv/restricted",
      });
      if (!restricted) throw new Error("Missing Library.");
      await db
        .update(versions)
        .set({ libraryId: restricted.id })
        .where(eq(versions.itemId, at(fx.numbered[2] ?? [], 0)));
      await setRule(db, fx.admin.id, {
        subject: { type: "user", id: fx.viewer.id },
        object: { type: "library", id: restricted.id },
        action: "view",
        allowed: false,
      });
      expect(
        (await client.playback.next({ itemId: at(fx.numbered[1] ?? [], 1) }))
          ?.id,
      ).toBe(at(fx.numbered[2] ?? [], 1));
    }));

  test("the series finale has no next Episode", () =>
    withShow(async (_db, fx, client) => {
      expect(
        await client.playback.next({ itemId: at(fx.numbered[2] ?? [], 2) }),
      ).toBeNull();
    }));

  test("a Movie has no next Episode and a denied Item is forbidden", () =>
    withShow(async (db, fx, client) => {
      expect(await client.playback.next({ itemId: fx.movie.id })).toBeNull();
      await setRule(db, fx.admin.id, {
        subject: { type: "user", id: fx.viewer.id },
        object: { type: "item", id: at(fx.numbered[1] ?? [], 0) },
        action: "view",
        allowed: false,
      });
      await expect(
        client.playback.next({ itemId: at(fx.numbered[1] ?? [], 0) }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        client.playback.next({ itemId: crypto.randomUUID() }),
      ).rejects.toBeInstanceOf(ORPCError);
    }));
});
