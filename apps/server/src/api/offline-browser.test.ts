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

/** A stored subtitle file of the Item, saved with the download as the store does. */
type Saved = { track: string; language: string; content: string };

type Fixture = {
  name: string;
  options: VideoFixtureOptions;
  itemId: string;
  versionId: string;
  saved: Saved[];
};

const fixture = (
  name: string,
  options: VideoFixtureOptions,
  saved: Saved[] = [],
): Fixture => ({
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
  saved,
});

// Shown from here, far enough in that reaching it needs a seek past the buffer.
const cueSeconds = 200;

const fixtures = {
  mkv: fixture("long.mkv", { durationSeconds: longSeconds }),
  mp4: fixture("short.mp4", { durationSeconds: 4 }),
  hevc: fixture("hevc.mkv", { durationSeconds: 4, videoCodec: "hevc" }),
  ac3: fixture("ac3.mkv", { durationSeconds: 4, audioCodec: "ac3" }),
  // Black frames, so drawn subtitles are the only bright pixels. The SubRip
  // track is Dutch and forced, the ASS track English.
  early: fixture("early.mkv", {
    durationSeconds: 4,
    subtitles: ["srt"],
    subtitleTime: { start: 0.5, end: 3.5 },
  }),
  subtitles: fixture(
    "subtitles.mkv",
    {
      durationSeconds: longSeconds,
      pattern: "color",
      subtitles: ["srt", "ass"],
      subtitleTime: { start: cueSeconds, end: cueSeconds + 30 },
    },
    [
      {
        track: "en.srt",
        language: "en",
        content: "1\n00:00:01,000 --> 00:00:30,000\nStored\n",
      },
    ],
  ),
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

/** Clicks the element `element` evaluates to with a real mouse, as bits-ui menus need. */
async function click(page: Page, element: string) {
  await page.waitFor(element);
  const at = await page.eval<{ x: number; y: number }>(`(() => {
    const box = (${element}).getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  })()`);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
  for (const type of ["mousePressed", "mouseReleased"])
    await page.send("Input.dispatchMouseEvent", {
      type,
      ...at,
      button: "left",
      clickCount: 1,
    });
}

/** Focuses the menu item `element` evaluates to and presses Enter; a click can land mid-animation. */
async function press(page: Page, element: string) {
  await page.waitFor(element);
  await page.eval(`(${element}).focus()`);
  for (const type of ["keyDown", "keyUp"])
    await page.send("Input.dispatchKeyEvent", {
      type,
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
}

const find = (selector: string, test: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find((element) => ${test})`;

/** Picks a subtitle option from the player's settings menu by its name. */
async function chooseSubtitles(page: Page, name: string) {
  // Paused, the controls stay up.
  await page.eval(`${video}.pause()`);
  await page.waitFor(`document.querySelector('[data-controls="shown"]')`);
  await click(page, find("button", `element.ariaLabel === "Settings"`));
  // bits-ui remounts the menu's focus scope as its opening frame ends, which
  // sends focus to the trigger and back; a key pressed before that goes astray.
  await page.waitFor(
    `document.activeElement?.closest("[role=menu]:not([data-starting-style])")`,
  );
  await press(
    page,
    find("[role=menuitem]", `element.ariaLabel?.startsWith("Subtitles,")`),
  );
  // The switch reopens the session, which empties the video first.
  await page.eval(
    `window.reopened = false; ${video}.addEventListener("emptied", () => { window.reopened = true; }, { once: true })`,
  );
  await press(
    page,
    find(
      "[role=menuitemradio]",
      `element.textContent.trim() === ${JSON.stringify(name)}`,
    ),
  );
  await page.waitFor(
    `window.reopened && ${video}.readyState >= 2 && !document.querySelector("[role=menu]")`,
    30_000,
  );
}

/** The text of the cues showing now, across the video's showing text tracks. */
const activeCues = `[...${video}.textTracks]
  .filter((track) => track.mode === "showing")
  .flatMap((track) => [...(track.activeCues ?? [])])
  .map((cue) => ({ text: cue.text, start: cue.startTime }))`;

/** Counts near-white screen pixels in the video's top half and bottom quarter, with the player's bars hidden. */
async function brightPixels(page: Page) {
  await page.eval(
    `document.querySelectorAll("[data-bar]").forEach((bar) => { bar.style.display = "none"; })`,
  );
  const shot = (await page.send("Page.captureScreenshot", {
    format: "png",
  })) as unknown as { data: string };
  await page.eval(
    `document.querySelectorAll("[data-bar]").forEach((bar) => { bar.style.display = ""; })`,
  );
  return page.eval<{ top: number; bottom: number }>(`(async () => {
    const blob = await (await fetch("data:image/png;base64,${shot.data}")).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const box = ${video}.getBoundingClientRect();
    let top = 0;
    let bottom = 0;
    for (let y = 0; y < bitmap.height; y += 1)
      for (let x = 0; x < bitmap.width; x += 1) {
        const i = (y * bitmap.width + x) * 4;
        if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) continue;
        if (y < box.y + box.height / 2) top += 1;
        else if (y > box.y + box.height * 0.75) bottom += 1;
      }
    return { top, bottom };
  })()`);
}

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
        subtitles: entry.saved.map((saved) => ({
          language: saved.language,
          format: "srt",
          forced: false,
          hearingImpaired: false,
          name: `${entry.versionId}.${saved.track}`,
        })),
      });
      for (const saved of entry.saved)
        await Bun.write(
          join(dir, `${entry.versionId}.${saved.track}`),
          saved.content,
        );
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
      const save = async (name, from) => {
        const bytes = await (await fetch("/__fixtures/" + from)).arrayBuffer();
        const file = await dir.getFileHandle(name, { create: true });
        const writable = await file.createWritable();
        await writable.write(bytes);
        await writable.close();
      };
      for (const record of records) {
        await save(record.versionId, record.title);
        for (const { name } of record.subtitles) await save(name, name);
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

  test("a forced SubRip cue at the very start shows", async () => {
    await openDownload(page, base, fixtures.early);
    await page.waitFor(`${activeCues}.length > 0`, 10_000);
    expect(
      await page.eval<{ text: string; start: number }[]>(activeCues),
    ).toEqual([{ text: "Fixture", start: expect.closeTo(0.5, 1) }]);
  }, 60_000);

  test("a forced SubRip track shows on its own, timed right after a seek past the buffer", async () => {
    await openDownload(page, base, fixtures.subtitles);
    expect(await page.eval<unknown[]>(activeCues)).toEqual([]);
    await page.eval(`${video}.currentTime = ${cueSeconds + 5}`);
    await page.waitFor(`${activeCues}.length > 0`, 30_000);
    const [cue] =
      await page.eval<{ text: string; start: number }[]>(activeCues);
    expect(cue?.text).toBe("Fixture");
    expect(cue?.start).toBeCloseTo(cueSeconds, 1);
  }, 60_000);

  test("an ASS track draws over the video at its bottom", async () => {
    await openDownload(page, base, fixtures.subtitles);
    await chooseSubtitles(page, "English (2)");
    await page.waitFor("document.querySelector('canvas.JASSUB')", 30_000);
    await page.eval(`${video}.play()`);
    expect(await brightPixels(page)).toEqual({ top: 0, bottom: 0 });
    await page.eval(`${video}.currentTime = ${cueSeconds + 5}`);
    await page.waitFor(
      `${video}.currentTime > ${cueSeconds + 5.5} && !${video}.paused`,
      30_000,
    );
    const drawn = await brightPixels(page);
    expect(drawn.top).toBe(0);
    expect(drawn.bottom).toBeGreaterThan(50);
  }, 60_000);

  test("a stored subtitle file saved with the download is in the same menu", async () => {
    await openDownload(page, base, fixtures.subtitles);
    await chooseSubtitles(page, "English (3)");
    await page.eval(`${video}.currentTime = 5`);
    await page.waitFor(`${activeCues}.length > 0`, 30_000);
    expect(
      await page.eval<{ text: string; start: number }[]>(activeCues),
    ).toEqual([{ text: "Stored", start: 1 }]);
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
      Object.values(fixtures).flatMap((entry) => [
        [`downloads/${entry.versionId}`, Bun.file(join(dir, entry.name)).size],
        ...entry.saved.map((saved) => [
          `downloads/${entry.versionId}.${saved.track}`,
          saved.content.length,
        ]),
      ]),
    );
    const { "downloads/index.json": index, ...media } = files;
    expect(index).toBeGreaterThan(0);
    expect(media).toEqual(expected);
  });
});
