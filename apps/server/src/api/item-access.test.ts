import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createThaliaClient } from "../../../web/src/lib/api.ts";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { createGroup, setUserGroups } from "../auth/permissions.ts";
import { setRule } from "../auth/rules.ts";
import { createApiKey } from "../auth/sessions.ts";
import { writeAuthSettings } from "../auth/settings.ts";
import type { Database } from "../db/client.ts";
import {
  accessRules,
  artwork,
  files,
  items,
  streams,
  versions,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { deleteItemSubtree, insertItem } from "../db/tree.ts";
import { startThalia } from "../index.ts";
import { toGuid } from "../jellyfin/request.ts";
import { insertLibraries } from "../libraries/testing.ts";
import { editItemMetadata } from "../metadata/edit.ts";
import { deleteItemImage, listItemImages } from "../metadata/images.ts";
import { pingPlayback } from "../playback/activity.ts";
import { subtitleSource, uploadSubtitle } from "../subtitles/service.ts";

const profile = {
  containers: ["mkv"],
  videoCodecs: [{ codec: "h264" }],
  audioCodecs: [{ codec: "aac", maxChannels: 2 }],
  subtitleFormats: ["srt"],
  hdr: ["sdr" as const],
};
const track = { language: "en", format: "srt" as const, forced: false };
const subtitle = new TextEncoder().encode(
  "1\n00:00:00,000 --> 00:00:01,000\nHello\n",
);

async function seed(db: Database, root: string) {
  const admin = await setupAdmin(db, {
    username: "admin",
    password: "admin-pass",
  });
  const viewer = await createLocalUser(db, admin.id, {
    username: "viewer",
    password: "viewer-pass",
  });
  await writeAuthSettings(db, admin.id, { artworkRequiresAuth: true });
  const group = await createGroup(db, admin.id, {
    name: "restricted",
    permissions: [],
  });
  const userGroups = await db.query.groups.findMany({
    where: (groups, { eq }) => eq(groups.name, "users"),
  });
  await setUserGroups(db, admin.id, viewer.id, [
    group.id,
    ...userGroups.map((g) => g.id),
  ]);
  const [library] = await insertLibraries(db, {
    name: "Tree",
    medium: "shows",
    rootPath: root,
  });
  if (!library) throw new Error("Missing Library.");
  const show = await insertItem(db, {
    libraryId: library.id,
    kind: "show",
    title: "Show",
    canonicalFolder: ".",
    extension: {},
  });
  const episodes = [];
  const seasons = [];
  for (const seasonNumber of [1, 2]) {
    const season = await insertItem(db, {
      libraryId: library.id,
      kind: "season",
      parentId: show.id,
      title: `Season ${seasonNumber}`,
      canonicalFolder: ".",
      extension: { seasonNumber },
    });
    seasons.push(season);
    for (const episodeNumber of [1, 2]) {
      episodes.push(
        await insertItem(db, {
          libraryId: library.id,
          kind: "episode",
          parentId: season.id,
          title: `Episode ${seasonNumber}.${episodeNumber}`,
          canonicalFolder: ".",
          extension: { episodeNumber },
        }),
      );
    }
  }
  // A mixed fixture keeps the unrelated movie in the same permission chain.
  const [movie] = await db
    .insert(items)
    .values({
      libraryId: library.id,
      kind: "movie",
      title: "Movie",
      canonicalFolder: ".",
    })
    .returning();
  if (!movie) throw new Error("Missing movie.");
  const playable = [];
  for (const item of [...episodes, movie]) {
    const path = `${item.id}.mkv`;
    await Bun.write(join(root, path), "media fixture");
    const [version] = await db
      .insert(versions)
      .values({
        itemId: item.id,
        itemKind: item.kind,
        libraryId: library.id,
        label: "Original",
        format: "video",
        bytes: 13n,
        durationSeconds: 60,
      })
      .returning();
    if (!version) throw new Error("Missing Version.");
    const [file] = await db
      .insert(files)
      .values({
        itemId: item.id,
        libraryId: library.id,
        versionId: version.id,
        rootId: library.rootId,
        path,
        order: 0,
        bytes: 13n,
        modifiedAt: new Date(),
        container: "mkv",
        durationSeconds: 60,
      })
      .returning();
    if (!file) throw new Error("Missing File.");
    await db.insert(streams).values({
      versionId: version.id,
      fileId: file.id,
      index: 0,
      kind: "video",
      codec: "h264",
      width: 320,
      height: 180,
      bitrate: 1000n,
      hdr: "sdr",
    });
    const [image] = await db
      .insert(artwork)
      .values({
        itemId: item.id,
        type: "poster",
        backend: "colocated",
        storageKey: `${item.id}.png`,
        selected: true,
      })
      .returning();
    if (!image) throw new Error("Missing artwork.");
    const [versionImage] = await db
      .insert(artwork)
      .values({
        versionId: version.id,
        type: "thumb",
        backend: "colocated",
        storageKey: `${item.id}-version.png`,
        selected: true,
      })
      .returning();
    if (!versionImage) throw new Error("Missing Version artwork.");
    playable.push({ item, version, image, versionImage });
  }
  const { token } = await createApiKey(db, viewer.id, "viewer");
  const { token: adminToken } = await createApiKey(db, admin.id, "admin");
  return {
    admin,
    viewer,
    group,
    library,
    show,
    seasons,
    episodes,
    movie,
    playable,
    token,
    adminToken,
  };
}

async function withTree(
  run: (
    db: Database,
    fx: Awaited<ReturnType<typeof seed>>,
    base: string,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "thalia-item-rules-"));
  try {
    await withDatabase(async (db, url) => {
      const fx = await seed(db, root);
      const server = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        await run(db, fx, `http://127.0.0.1:${server.apiServer?.port}`);
      } finally {
        await server.stop();
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function request(
  base: string,
  token: string,
  path: string,
  method = "GET",
  body?: object,
) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "X-Emby-Token": token,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe.skipIf(!databaseUrl)("single-Item Access rules", () => {
  test("a Group's show denial refuses every Episode across single-Item endpoints", () =>
    withTree(async (db, fx, base) => {
      await setRule(db, fx.admin.id, {
        subject: { type: "group", id: fx.group.id },
        object: { type: "item", id: fx.show.id },
        action: "view",
        allowed: false,
      });
      for (const { item, version, image, versionImage } of fx.playable.filter(
        ({ item }) => item.kind === "episode",
      )) {
        for (const [path, method, body] of [
          [`/api/items/${item.id}`, "GET"],
          [`/api/items/${item.id}/progress`, "GET"],
          [`/api/items/${item.id}/favourite`, "PUT", { favourite: true }],
          [
            `/api/playback/plan`,
            "POST",
            { itemId: item.id, versionId: version.id, profile },
          ],
          [`/api/artwork/${image.id}?width=32`, "GET"],
          [`/api/artwork/${versionImage.id}?width=32`, "GET"],
          [`/api/subtitles/${item.id}/en.srt`, "GET"],
          [`/Items/${toGuid(item.id)}/Download`, "GET"],
        ] as const)
          expect(
            (await request(base, fx.token, path, method, body)).status,
          ).toBe(403);
        expect(
          (await request(base, fx.token, `/Items/${toGuid(item.id)}`)).status,
        ).toBe(404);
        await expect(
          subtitleSource(db, fx.viewer.id, item.id, version.id, 0),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(
          listItemImages(db, fx.viewer.id, item.id),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
      expect(
        (await request(base, fx.token, `/api/items/${fx.movie.id}`)).status,
      ).toBe(200);
    }));

  test("one Episode exception permits playback and download inside a denied Library", () =>
    withTree(async (db, fx, base) => {
      const chosen = fx.playable[0];
      if (!chosen) throw new Error("Missing Episode.");
      const subject = { type: "user" as const, id: fx.viewer.id };
      await setRule(db, fx.admin.id, {
        subject,
        object: { type: "library", id: fx.library.id },
        action: "view",
        allowed: false,
      });
      await setRule(db, fx.admin.id, {
        subject,
        object: { type: "item", id: chosen.item.id },
        action: "view",
        allowed: true,
      });
      const client = createThaliaClient({
        origin: base,
        headers: { authorization: `Bearer ${fx.token}` },
      });
      const plan = await client.playback.plan({
        itemId: chosen.item.id,
        versionId: chosen.version.id,
        profile,
      });
      expect(plan.method).toBe("direct-play");
      if (plan.sessionId === null) throw new Error("Missing playback session.");
      expect((await fetch(`${base}${plan.url}`)).status).toBe(200);
      await pingPlayback(db, fx.viewer.id, plan.sessionId);
      expect(
        await (
          await request(
            base,
            fx.token,
            `/Items/${toGuid(chosen.item.id)}/Download`,
          )
        ).text(),
      ).toBe("media fixture");
      expect(
        (await request(base, fx.token, `/Items/${toGuid(chosen.item.id)}`))
          .status,
      ).toBe(200);
      for (const item of [
        fx.show,
        ...fx.seasons,
        ...fx.episodes.slice(1),
        fx.movie,
      ]) {
        expect(
          (await request(base, fx.token, `/api/items/${item.id}`)).status,
        ).toBe(403);
        expect(
          (await request(base, fx.token, `/Items/${toGuid(item.id)}`)).status,
        ).toBe(404);
        expect(
          (await request(base, fx.token, `/Items/${toGuid(item.id)}/Download`))
            .status,
        ).toBe(403);
      }
      // Revocation applies to an already issued playback token and its session.
      await setRule(db, fx.admin.id, {
        subject,
        object: { type: "item", id: chosen.item.id },
        action: "view",
        allowed: false,
      });
      expect((await fetch(`${base}${plan.url}`)).status).toBe(403);
      await expect(
        pingPlayback(db, fx.viewer.id, plan.sessionId),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        client.playback.refresh({
          sessionId: plan.sessionId,
          itemId: chosen.item.id,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        client.playback.start({
          sessionId: plan.sessionId,
          itemId: chosen.item.id,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }));

  test("metadata and subtitle edits inherit only within the allowed show", () =>
    withTree(async (db, fx) => {
      for (const action of ["metadata:edit", "subtitles:edit"] as const)
        await setRule(db, fx.admin.id, {
          subject: { type: "user", id: fx.viewer.id },
          object: { type: "item", id: fx.show.id },
          action,
          allowed: true,
        });
      for (const item of [fx.show, ...fx.seasons, ...fx.episodes]) {
        await editItemMetadata(db, fx.viewer.id, item.id, {
          overview: "Edited",
        });
        await uploadSubtitle(db, fx.viewer.id, item.id, track, subtitle);
        await deleteItemImage(db, fx.viewer.id, item.id, "thumb");
      }
      expect(
        (
          await db
            .select()
            .from(items)
            .where(eq(items.id, fx.episodes[0]?.id ?? ""))
        )[0]?.overview,
      ).toBe("Edited");
      await expect(
        editItemMetadata(db, fx.viewer.id, fx.movie.id, {
          overview: "Refused",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        uploadSubtitle(db, fx.viewer.id, fx.movie.id, track, subtitle),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        deleteItemImage(db, fx.viewer.id, fx.movie.id, "thumb"),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }));

  test("play without view refuses playback", () =>
    withTree(async (db, fx, base) => {
      const chosen = fx.playable[0];
      if (!chosen) throw new Error("Missing Episode.");
      for (const [action, allowed] of [
        ["view", false],
        ["play", true],
      ] as const)
        await setRule(db, fx.admin.id, {
          subject: { type: "user", id: fx.viewer.id },
          object: { type: "item", id: chosen.item.id },
          action,
          allowed,
        });
      expect(
        (
          await request(base, fx.token, "/api/playback/plan", "POST", {
            itemId: chosen.item.id,
            versionId: chosen.version.id,
            profile,
          })
        ).status,
      ).toBe(403);
    }));

  test("deleting an Item cascades its rules", () =>
    withTree(async (db, fx) => {
      await setRule(db, fx.admin.id, {
        subject: { type: "user", id: fx.viewer.id },
        object: { type: "item", id: fx.show.id },
        action: "view",
        allowed: false,
      });
      await deleteItemSubtree(db, fx.show.id);
      expect(
        await db
          .select()
          .from(accessRules)
          .where(eq(accessRules.itemId, fx.show.id)),
      ).toEqual([]);
    }));
});
