import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import {
  createVideoFixture,
  type VideoFixtureOptions,
} from "../mediums/video-common/fixtures.ts";
import { probeVideo } from "../mediums/video-common/probe.ts";
import { browser, openPage, type Page, webBuild } from "./browser-testing.ts";

// Long enough that a seek near the end lands past the buffered ninety seconds,
// so the remux restarts at the target.
const longSeconds = 240;

type Fixture = {
  name: string;
  options: VideoFixtureOptions;
  itemId: string;
  versionId: string;
};

const fixture = (name: string, options: VideoFixtureOptions): Fixture => ({
  name,
  options: {
    width: 320,
    height: 180,
    frameRate: 25,
    gopSeconds: 2,
    pattern: "testsrc2",
    subtitles: [],
    ...options,
  },
  itemId: crypto.randomUUID(),
  versionId: crypto.randomUUID(),
});

const fixtures = {
  mkv: fixture("long.mkv", { durationSeconds: longSeconds }),
  mp4: fixture("short.mp4", { durationSeconds: 4 }),
  hevc: fixture("hevc.mkv", { durationSeconds: 4, videoCodec: "hevc" }),
  ac3: fixture("ac3.mkv", { durationSeconds: 4, audioCodec: "ac3" }),
};

const video = "document.querySelector('video')";

/** Opens a download in the player and clicks Play if the browser refused autoplay. */
async function openDownload(page: Page, base: string, entry: Fixture) {
  await page.goto(
    `${base}/play/${entry.itemId}?version=${entry.versionId}&offline`,
  );
  await page.waitFor(`${video}?.readyState >= 2`, 30_000);
  await page.eval(`(() => {
    if (!${video}.paused) return;
    [...document.querySelectorAll('button')]
      .find((button) => button.getAttribute('aria-label') === 'Play')
      ?.click();
  })()`);
  await page.waitFor(`!${video}.paused && ${video}.currentTime > 0.5`, 30_000);
}

const noticeText = `document.querySelector('[role="alert"]')?.innerText ?? ''`;

describe.skipIf(browser === undefined)("offline playback", () => {
  let dir: string;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let page: Page;
  let base: string;

  beforeAll(async () => {
    if (!existsSync(webBuild))
      throw new Error("Build apps/web before this test.");
    dir = await mkdtemp(join(tmpdir(), "thalia-offline-browser-"));
    const records = [];
    for (const entry of Object.values(fixtures)) {
      const path = join(dir, entry.name);
      await createVideoFixture(path, entry.options);
      const probe = await probeVideo(path);
      records.push({
        itemId: entry.itemId,
        versionId: entry.versionId,
        title: entry.name,
        bytes: Bun.file(path).size,
        container: probe.container,
        streams: probe.streams.map((stream) => ({
          index: stream.index,
          kind: stream.kind,
          codec: stream.codec,
          profile: stream.profile,
          language: stream.language,
          title: stream.title,
          channels: stream.channels,
          width: stream.width,
          height: stream.height,
          hdr: stream.hdr,
          default: stream.disposition.default === true,
          forced: stream.disposition.forced === true,
        })),
        written: Bun.file(path).size,
        state: "complete",
        etag: null,
      });
    }
    // The built shell and the fixtures; no API, as if the server were down.
    const build = join(webBuild, "..");
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = normalize(
          decodeURIComponent(new URL(request.url).pathname),
        );
        if (path.startsWith("/__fixtures/"))
          return new Response(Bun.file(join(dir, path.slice(12))));
        if (path.startsWith("/rpc") || path.startsWith("/api"))
          return new Response(null, { status: 404 });
        const file = join(build, path);
        if (path !== "/" && existsSync(file))
          return new Response(Bun.file(file));
        return new Response(Bun.file(webBuild), {
          headers: { "content-type": "text/html" },
        });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
    page = await openPage();
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page.goto(`${base}/`);
    // The service worker keeps the shell, so the player opens with nothing serving it.
    await page.eval("navigator.serviceWorker.ready.then(() => true)");
    await page.eval(`(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("downloads", { create: true });
      const records = ${JSON.stringify(records)};
      for (const record of records) {
        const bytes = await (await fetch("/__fixtures/" + record.title)).arrayBuffer();
        const file = await dir.getFileHandle(record.versionId, { create: true });
        const writable = await file.createWritable();
        await writable.write(bytes);
        await writable.close();
      }
      const index = await dir.getFileHandle("index.json", { create: true });
      const writable = await index.createWritable();
      await writable.write(JSON.stringify(records));
      await writable.close();
    })()`);
    await server.stop(true);
    server = undefined;
  }, 180_000);

  afterAll(async () => {
    await page?.close();
    await server?.stop(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("an H.264 and AAC MKV plays, seeks past the buffer and reaches the end", async () => {
    await openDownload(page, base, fixtures.mkv);
    await page.eval(`${video}.currentTime = ${longSeconds - 3}`);
    await page.waitFor(`${video}.ended`, 30_000);
    expect(await page.eval<string>(noticeText)).toBe("");
    // The end was reached from the seek, not by buffering the whole file.
    expect(await page.eval<number>(`${video}.buffered.length`)).toBeGreaterThan(
      1,
    );
  }, 90_000);

  test("an MP4 plays through the same path", async () => {
    await openDownload(page, base, fixtures.mp4);
    await page.waitFor(`${video}.ended`, 30_000);
    expect(await page.eval<string>(noticeText)).toBe("");
  }, 60_000);

  test("HEVC plays where the browser decodes it and says why where it can't", async () => {
    const decodes = await page.eval<boolean>(
      `MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L120.90"')`,
    );
    if (decodes) {
      await openDownload(page, base, fixtures.hevc);
      await page.waitFor(`${video}.ended`, 30_000);
      return;
    }
    await page.goto(
      `${base}/play/${fixtures.hevc.itemId}?version=${fixtures.hevc.versionId}&offline`,
    );
    await page.waitFor(noticeText, 30_000);
    expect(await page.eval<string>(noticeText)).toContain(
      "This browser can't play HEVC.",
    );
  }, 60_000);

  test("a download whose only audio the browser can't play says so", async () => {
    await page.goto(
      `${base}/play/${fixtures.ac3.itemId}?version=${fixtures.ac3.versionId}&offline`,
    );
    await page.waitFor(noticeText, 30_000);
    expect(await page.eval<string>(noticeText)).toContain(
      "Needs audio conversion.",
    );
  }, 60_000);

  test("playing keeps one copy of each download in browser storage", async () => {
    const files = await page.eval<Record<string, number>>(`(async () => {
      const sizes = {};
      const walk = async (dir, prefix) => {
        for await (const [name, handle] of dir.entries()) {
          if (handle.kind === "directory") await walk(handle, prefix + name + "/");
          else sizes[prefix + name] = (await handle.getFile()).size;
        }
      };
      await walk(await navigator.storage.getDirectory(), "");
      return sizes;
    })()`);
    const expected = Object.fromEntries(
      Object.values(fixtures).map((entry) => [
        `downloads/${entry.versionId}`,
        Bun.file(join(dir, entry.name)).size,
      ]),
    );
    const { "downloads/index.json": index, ...media } = files;
    expect(index).toBeGreaterThan(0);
    expect(media).toEqual(expected);
  });
});
