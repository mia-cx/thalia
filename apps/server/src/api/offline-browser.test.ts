import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import {
  createVideoFixture,
  pgsFixtureBox,
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

// Shown or heard from here, far enough in that reaching it needs a seek past the buffer.
const cueSeconds = 200;
const toneSeconds = 200;

const fixtures = {
  mkv: fixture("long.mkv", { durationSeconds: longSeconds }),
  mp4: fixture("short.mp4", { durationSeconds: 4 }),
  hevc: fixture("hevc.mkv", { durationSeconds: 4, videoCodec: "hevc" }),
  // Silent until the tone, so its onset shows where audio sits against video.
  ac3: fixture("ac3.mkv", {
    durationSeconds: longSeconds,
    pattern: "color",
    audioCodec: "ac3",
    audioChannels: 6,
    toneFrom: toneSeconds,
  }),
  dts: fixture("dts.mkv", {
    durationSeconds: 4,
    audioCodec: "dts",
    audioChannels: 6,
    toneFrom: 0,
  }),
  truehd: fixture("truehd.mkv", { durationSeconds: 4, audioCodec: "truehd" }),
  // A white box on black. The first track is forced and its caption isn't
  // flagged forced, so it shows nothing; the second shows the box.
  pgs: fixture("pgs.mkv", {
    durationSeconds: longSeconds,
    pattern: "color",
    subtitles: ["pgs", "pgs"],
    subtitleTime: { start: cueSeconds, end: cueSeconds + 30 },
  }),
  forcedPgs: fixture("forced-pgs.mkv", {
    durationSeconds: 4,
    pattern: "color",
    subtitles: ["pgs"],
    pgsForced: true,
    subtitleTime: { start: 0.5, end: 3.5 },
  }),
  vobsub: fixture("vobsub.mkv", {
    durationSeconds: 4,
    pattern: "color",
    subtitles: ["vobsub"],
    subtitleTime: { start: 0.5, end: 3.5 },
  }),
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

/**
 * Listens to the playing video's audio; `window.heardAt` becomes the
 * video's position when sound first plays, null until then.
 */
async function listen(page: Page) {
  await page.eval(`(async () => {
    window.heardAt = null;
    const media = ${video};
    const stream = media.captureStream();
    while (stream.getAudioTracks().length === 0)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const context = new AudioContext();
    await context.resume();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const sample = () => {
      analyser.getFloatTimeDomainData(samples);
      const loudest = samples.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0);
      if (loudest > 0.1) window.heardAt = media.currentTime;
      else setTimeout(sample, 5);
    };
    sample();
  })()`);
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

/**
 * Finds the near-white screen pixels over the video's picture, with the
 * player's bars hidden and subtitle canvases unshifted: how many lie in its
 * top 40% and its bottom half, and their bounds as fractions of the picture.
 */
async function brightPixels(page: Page) {
  const chrome = (hidden: boolean) =>
    page.eval(`(() => {
      for (const bar of document.querySelectorAll("[data-bar]"))
        bar.style.display = ${hidden ? '"none"' : '""'};
      for (const canvas of document.querySelectorAll("canvas"))
        canvas.style.transition = canvas.style.translate = ${hidden ? '"none"' : '""'};
    })()`);
  await chrome(true);
  const shot = (await page.send("Page.captureScreenshot", {
    format: "png",
  })) as unknown as { data: string };
  await chrome(false);
  return page.eval<{
    top: number;
    bottom: number;
    bounds: { left: number; top: number; right: number; bottom: number };
  }>(`(async () => {
    const blob = await (await fetch("data:image/png;base64,${shot.data}")).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const media = ${video};
    const element = media.getBoundingClientRect();
    const ratio = media.videoWidth / media.videoHeight;
    const width = Math.min(element.width, element.height * ratio);
    const height = width / ratio;
    const left = element.x + (element.width - width) / 2;
    const top = element.y + (element.height - height) / 2;
    const bounds = { left: 1, top: 1, right: 0, bottom: 0 };
    let upper = 0;
    let lower = 0;
    for (let y = 0; y < bitmap.height; y += 1)
      for (let x = 0; x < bitmap.width; x += 1) {
        const i = (y * bitmap.width + x) * 4;
        if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) continue;
        const u = (x - left) / width;
        const v = (y - top) / height;
        if (v < 0.4) upper += 1;
        else if (v > 0.5) lower += 1;
        bounds.left = Math.min(bounds.left, u);
        bounds.top = Math.min(bounds.top, v);
        bounds.right = Math.max(bounds.right, (x + 1 - left) / width);
        bounds.bottom = Math.max(bounds.bottom, (y + 1 - top) / height);
      }
    return { top: upper, bottom: lower, bounds };
  })()`);
}

/** Bright pixels once something has drawn; renderers draw a frame or two after the time arrives. */
async function drawnPixels(page: Page) {
  for (let attempt = 0; ; attempt += 1) {
    const pixels = await brightPixels(page);
    if (pixels.top + pixels.bottom > 0 || attempt === 20) return pixels;
    await Bun.sleep(100);
  }
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

  test("an AC-3-only download plays with sound, in sync after a seek past the buffer", async () => {
    await openDownload(page, base, fixtures.ac3);
    await listen(page);
    await page.eval(`${video}.currentTime = ${toneSeconds - 1.5}`);
    await page.waitFor("window.heardAt !== null", 30_000);
    // The tone starts with the video's second 200, not seconds off. Native
    // AAC measures 0.12 s early here too: the listener hears ahead of
    // currentTime.
    expect(await page.eval<number>("window.heardAt")).toBeGreaterThan(
      toneSeconds - 0.3,
    );
    expect(await page.eval<number>("window.heardAt")).toBeLessThan(
      toneSeconds + 0.3,
    );
  }, 60_000);

  test("a DTS-only download plays with sound", async () => {
    await openDownload(page, base, fixtures.dts);
    await listen(page);
    await page.waitFor("window.heardAt !== null", 30_000);
    expect(await page.eval<string>(noticeText)).toBe("");
  }, 60_000);

  test("a TrueHD-only download asks for a server copy", async () => {
    await page.goto(
      `${base}/play/${fixtures.truehd.itemId}?version=${fixtures.truehd.versionId}&offline`,
    );
    await page.waitFor(noticeText, 30_000);
    expect(await page.eval<string>(noticeText)).toContain(
      "Needs a server copy.",
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
    expect(await brightPixels(page)).toMatchObject({ top: 0, bottom: 0 });
    await page.eval(`${video}.currentTime = ${cueSeconds + 5}`);
    await page.waitFor(
      `${video}.currentTime > ${cueSeconds + 5.5} && !${video}.paused`,
      30_000,
    );
    const drawn = await drawnPixels(page);
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

  test("a PGS track draws its box in place after a seek past the buffer, without dropping frames", async () => {
    await openDownload(page, base, fixtures.pgs);
    await chooseSubtitles(page, "English");
    await page.waitFor("document.querySelector('canvas[data-subtitles]')");
    await page.eval(`${video}.play()`);
    expect(await brightPixels(page)).toMatchObject({ top: 0, bottom: 0 });
    await page.eval(`${video}.currentTime = ${cueSeconds - 1}`);
    await page.waitFor(`${video}.currentTime > ${cueSeconds - 0.5}`, 30_000);
    const dropped = await page.eval<number>(
      `${video}.getVideoPlaybackQuality().droppedVideoFrames`,
    );
    await page.waitFor(`${video}.currentTime > ${cueSeconds + 1.5}`, 30_000);
    // Across the caption appearing, no frame was dropped.
    expect(
      await page.eval<number>(
        `${video}.getVideoPlaybackQuality().droppedVideoFrames`,
      ),
    ).toBe(dropped);
    const drawn = await drawnPixels(page);
    const box = pgsFixtureBox(320, 180);
    expect(drawn.top).toBe(0);
    expect(drawn.bottom).toBeGreaterThan(1000);
    expect(drawn.bounds.left).toBeCloseTo(box.x / 320, 1);
    expect(drawn.bounds.right).toBeCloseTo((box.x + box.width) / 320, 1);
    expect(drawn.bounds.top).toBeCloseTo(box.y / 180, 1);
    expect(drawn.bounds.bottom).toBeCloseTo((box.y + box.height) / 180, 1);
  }, 60_000);

  test("a forced PGS track shows only the captions flagged forced", async () => {
    // The forced track is on by default; its unflagged caption stays hidden.
    await openDownload(page, base, fixtures.pgs);
    await page.waitFor("document.querySelector('canvas[data-subtitles]')");
    await page.eval(`${video}.currentTime = ${cueSeconds + 1}`);
    await page.waitFor(`${video}.currentTime > ${cueSeconds + 1.5}`, 30_000);
    expect(await brightPixels(page)).toMatchObject({ top: 0, bottom: 0 });
    // A flagged caption on a forced track shows.
    await openDownload(page, base, fixtures.forcedPgs);
    await page.waitFor(`${video}.currentTime > 1`, 30_000);
    expect((await drawnPixels(page)).bottom).toBeGreaterThan(1000);
  }, 60_000);

  test("a VobSub track draws its picture", async () => {
    await openDownload(page, base, fixtures.vobsub);
    await page.waitFor("document.querySelector('canvas[data-subtitles]')");
    await page.waitFor(`${video}.currentTime > 1`, 30_000);
    const drawn = await drawnPixels(page);
    expect(drawn.top).toBe(0);
    expect(drawn.bottom).toBeGreaterThan(1000);
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
