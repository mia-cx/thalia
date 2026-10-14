import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { setPermissionOverride } from "../auth/permissions.ts";
import { login } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  accessRules,
  files,
  items,
  streams,
  versions,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startThalia } from "../index.ts";
import { insertLibraries } from "../libraries/testing.ts";

const device = {
  clientName: "Test Client",
  deviceId: "device-1",
  deviceName: "Living Room",
};

const fixtureBytes = "0123456789abcdefghijklmnopqrstuvwxyz";

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "thalia-download-"));
  await writeFile(join(root, "movie.mp4"), fixtureBytes);
  await writeFile(join(root, "it's (draft).mp4"), fixtureBytes);
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function seedDownload(db: Database, root: string) {
  const admin = await setupAdmin(db, {
    username: "admin",
    password: "secret",
  });
  const owner = await createLocalUser(db, admin.id, {
    username: "owner",
    password: "owner-pass",
  });
  const { token } = await login(
    db,
    { username: "owner", password: "owner-pass", ...device },
    "127.0.0.1",
  );
  const [library] = await insertLibraries(db, {
    name: "Movies",
    medium: "movies",
    rootPath: root,
  });
  if (!library) throw new Error("Library insert returned no row.");
  const insertItem = async (title: string, folder: string) => {
    const [item] = await db
      .insert(items)
      .values({
        libraryId: library.id,
        kind: "movie",
        title,
        canonicalFolder: folder,
      })
      .returning();
    if (!item) throw new Error("Item insert returned no row.");
    return item;
  };
  const insertVersion = async (item: { id: string }) => {
    const [version] = await db
      .insert(versions)
      .values({
        itemId: item.id,
        itemKind: "movie",
        libraryId: library.id,
        label: "Original",
        format: "video",
        bytes: 36n,
        durationSeconds: 120,
      })
      .returning();
    if (!version) throw new Error("Version insert returned no row.");
    return version;
  };
  const item = await insertItem("Movie", "movie");
  const version = await insertVersion(item);
  const [file] = await db
    .insert(files)
    .values({
      versionId: version.id,
      itemId: item.id,
      libraryId: library.id,
      rootId: library.rootId,
      path: "movie.mp4",
      order: 0,
      bytes: 36n,
      modifiedAt: new Date(),
      container: "mp4",
      durationSeconds: 120,
    })
    .returning();
  if (!file) throw new Error("File insert returned no row.");
  await db.insert(streams).values({
    versionId: version.id,
    fileId: file.id,
    index: 0,
    kind: "video",
    codec: "h264",
    width: 1920,
    height: 1080,
    bitrate: 5_000_000n,
    hdr: "sdr",
  });
  // A second Item's Version: downloading it through the first Item's URL is a 404.
  const other = await insertItem("Other", "other");
  const otherVersion = await insertVersion(other);
  const [otherFile] = await db
    .insert(files)
    .values({
      versionId: otherVersion.id,
      itemId: other.id,
      libraryId: library.id,
      rootId: library.rootId,
      path: "it's (draft).mp4",
      order: 0,
      bytes: 36n,
      modifiedAt: new Date(),
      container: "mp4",
      durationSeconds: 120,
    })
    .returning();
  if (!otherFile) throw new Error("File insert returned no row.");
  await db.insert(streams).values({
    versionId: otherVersion.id,
    fileId: otherFile.id,
    index: 0,
    kind: "video",
    codec: "h264",
    width: 1920,
    height: 1080,
    bitrate: 5_000_000n,
    hdr: "sdr",
  });
  return {
    admin,
    owner,
    token,
    library,
    item,
    version,
    file,
    other,
    otherVersion,
  };
}

describe.skipIf(!databaseUrl)("downloads", () => {
  test("a session cookie downloads the file with byte ranges", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fixture = await makeFixture();
      try {
        const fx = await seedDownload(db, fixture.root);
        const server = await startThalia("api", { databaseUrl: url, port: 0 });
        try {
          const base = `http://127.0.0.1:${server.apiServer?.port}`;
          const path = `/api/items/${fx.item.id}/versions/${fx.version.id}/download`;
          const cookie = `thalia_session=${fx.token}`;

          const full = await fetch(`${base}${path}`, { headers: { cookie } });
          expect(full.status).toBe(200);
          expect(full.headers.get("content-disposition")).toBe(
            `attachment; filename="movie.mp4"; filename*=UTF-8''movie.mp4`,
          );
          expect(full.headers.get("accept-ranges")).toBe("bytes");
          expect(full.headers.get("content-length")).toBe("36");
          expect(full.headers.get("cache-control")).toBe("no-store");
          expect(await full.text()).toBe(fixtureBytes);

          const ranged = await fetch(`${base}${path}`, {
            headers: { cookie, range: "bytes=10-" },
          });
          expect(ranged.status).toBe(206);
          expect(ranged.headers.get("content-range")).toBe("bytes 10-35/36");
          expect(await ranged.text()).toBe(fixtureBytes.slice(10));

          const etag = full.headers.get("etag");
          expect(etag).not.toBeNull();
          const resumed = await fetch(`${base}${path}`, {
            headers: { cookie, range: "bytes=10-", "if-range": etag as string },
          });
          expect(resumed.status).toBe(206);
          expect(await resumed.text()).toBe(fixtureBytes.slice(10));

          const stale = await fetch(`${base}${path}`, {
            headers: { cookie, range: "bytes=10-", "if-range": '"stale"' },
          });
          expect(stale.status).toBe(200);
          expect(stale.headers.get("content-range")).toBeNull();
          expect(await stale.text()).toBe(fixtureBytes);

          const head = await fetch(`${base}${path}`, {
            method: "HEAD",
            headers: { cookie },
          });
          expect(head.status).toBe(200);
          expect(head.headers.get("content-length")).toBe("36");

          const posted = await fetch(`${base}${path}`, {
            method: "POST",
            headers: { cookie },
          });
          expect(posted.status).toBe(405);
          expect(posted.headers.get("allow")).toBe("GET, HEAD");
          await posted.body?.cancel();

          const bearer = await fetch(`${base}${path}`, {
            headers: { cookie, authorization: `Bearer ${fx.token}` },
          });
          expect(bearer.status).toBe(401);
          await bearer.body?.cancel();

          const foreign = await fetch(`${base}${path}`, {
            headers: { cookie, origin: "http://evil.test" },
          });
          expect(foreign.status).toBe(403);
          await foreign.body?.cancel();

          const noCookie = await fetch(`${base}${path}`);
          expect(noCookie.status).toBe(401);
          await noCookie.body?.cancel();
        } finally {
          await server.stop();
        }
      } finally {
        await fixture.cleanup();
      }
    }));

  test("download denied is 403 and a Version of another Item is 404", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fixture = await makeFixture();
      try {
        const fx = await seedDownload(db, fixture.root);
        const server = await startThalia("api", { databaseUrl: url, port: 0 });
        try {
          const base = `http://127.0.0.1:${server.apiServer?.port}`;
          const cookie = `thalia_session=${fx.token}`;
          const pathFor = (itemId: string, versionId: string) =>
            `/api/items/${itemId}/versions/${versionId}/download`;

          const foreign = await fetch(
            `${base}${pathFor(fx.item.id, fx.otherVersion.id)}`,
            { headers: { cookie } },
          );
          expect(foreign.status).toBe(404);
          await foreign.body?.cancel();

          // RFC 5987 encoding: ' ( ) * never pass through raw.
          const named = await fetch(
            `${base}${pathFor(fx.other.id, fx.otherVersion.id)}`,
            { headers: { cookie } },
          );
          expect(named.status).toBe(200);
          expect(named.headers.get("content-disposition")).toBe(
            `attachment; filename="it's (draft).mp4"; filename*=UTF-8''it%27s%20%28draft%29.mp4`,
          );
          await named.body?.cancel();

          const missing = await fetch(
            `${base}${pathFor(Bun.randomUUIDv7(), fx.version.id)}`,
            { headers: { cookie } },
          );
          expect(missing.status).toBe(404);
          await missing.body?.cancel();

          const badId = await fetch(
            `${base}/api/items/nope/versions/${fx.version.id}/download`,
            { headers: { cookie } },
          );
          expect(badId.status).toBe(404);
          await badId.body?.cancel();

          await setPermissionOverride(
            db,
            fx.admin.id,
            fx.owner.id,
            "download",
            false,
          );
          const denied = await fetch(
            `${base}${pathFor(fx.item.id, fx.version.id)}`,
            { headers: { cookie } },
          );
          expect(denied.status).toBe(403);
          await denied.body?.cancel();

          await db.insert(accessRules).values([
            {
              userId: fx.owner.id,
              libraryId: fx.library.id,
              action: "download",
              allowed: true,
            },
            {
              userId: fx.owner.id,
              itemId: fx.item.id,
              action: "download",
              allowed: false,
            },
          ]);
          const itemDenied = await fetch(
            `${base}${pathFor(fx.item.id, fx.version.id)}`,
            { headers: { cookie } },
          );
          expect(itemDenied.status).toBe(403);
          await itemDenied.body?.cancel();
        } finally {
          await server.stop();
        }
      } finally {
        await fixture.cleanup();
      }
    }));
});
