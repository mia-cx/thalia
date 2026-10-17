import { describe, expect, test } from "bun:test";
import { get } from "svelte/store";
import type { PlannedTracks } from "./player.ts";
import { createPlayer, type SessionRequest } from "./player-state.ts";

class FakeMedia extends EventTarget {
  currentTime = 0;
  duration = Number.NaN;
  paused = true;
  ended = false;
  volume = 1;
  muted = false;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  preservesPitch = false;
  videoWidth = 0;
  videoHeight = 0;
  buffered: {
    start(index: number): number;
    end(index: number): number;
    length: number;
  } = {
    length: 0,
    start: () => 0,
    end: () => 0,
  };
  refusePlay = false;
  playCalls = 0;

  play(): Promise<void> {
    this.playCalls += 1;
    if (this.refusePlay) return Promise.reject(new Error("autoplay refused"));
    this.paused = false;
    queueMicrotask(() => this.fire("play"));
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
    this.fire("pause");
  }

  fire(type: string) {
    this.dispatchEvent(new Event(type));
  }
}

type RecordedRequest = SessionRequest & {
  close: (options?: { completed?: boolean }) => Promise<void>;
  closed: boolean;
  closeOptions: { completed?: boolean } | undefined;
  capCalls: (readonly string[] | null)[];
  capLevels: (variantIds: readonly string[] | null) => boolean;
};

type FakeTimer = {
  run: () => void;
  cancelled: boolean;
  ran: boolean;
  ms: number;
};

/** A createPlayer on FakeMedia whose sessions and clock the test drives. */
function setup(
  overrides: Partial<Parameters<typeof createPlayer>[0]> = {},
  fake: { likeVideo?: boolean; capOk?: boolean } = {},
) {
  const media = new FakeMedia();
  const requests: RecordedRequest[] = [];
  const timers: FakeTimer[] = [];
  const player = createPlayer({
    media,
    versions: [
      { id: "v1", durationSeconds: 100 },
      { id: "v2", durationSeconds: 200 },
    ],
    versionId: "v1",
    startAt: null,
    open: (request) => {
      const entry: RecordedRequest = {
        ...request,
        closed: false,
        closeOptions: undefined,
        capCalls: [],
        capLevels: (variantIds) => {
          entry.capCalls.push(variantIds);
          return fake.capOk ?? true;
        },
        close: (options) => {
          entry.closeOptions = options;
          if (fake.likeVideo) {
            // video.load(): pauses and rewinds without firing any event.
            media.paused = true;
            media.currentTime = 0;
          }
          entry.closed = true;
          return Promise.resolve();
        },
      };
      requests.push(entry);
      if (fake.likeVideo && !request.paused) void media.play().catch(() => {});
      return entry;
    },
    schedule: (run, ms) => {
      const timer: FakeTimer = {
        run: () => {
          timer.ran = true;
          run();
        },
        cancelled: false,
        ran: false,
        ms,
      };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    ...overrides,
  });
  const tracks = (part: Partial<PlannedTracks> = {}): PlannedTracks =>
    ({
      audioStreams: [
        { index: 0, title: null, codec: "aac", language: "eng", channels: 2 },
        { index: 1, title: null, codec: "aac", language: "jpn", channels: 6 },
      ],
      subtitleStreams: [
        { index: 2, title: null, language: "eng", forced: false },
        { index: 3, title: null, language: "fra", forced: false },
      ],
      audioStreamIndex: 0,
      subtitleStreamIndex: null,
      creditsStartSeconds: null,
      quality: {
        original: null,
        rungs: [
          {
            name: "1080p",
            width: 1920,
            height: 1080,
            bitrate: 8_000_000,
            source: "stored",
            versionId: null,
            storedVariantIds: ["sv1"],
            available: true,
          },
          {
            name: "720p",
            width: 1280,
            height: 720,
            bitrate: 3_000_000,
            source: "transcode",
            versionId: null,
            storedVariantIds: [],
            available: true,
          },
        ],
        storedVariantIds: ["sv1", "sv2"],
      },
      ...part,
    }) as PlannedTracks;
  const state = () => get(player.state);
  const play = () => {
    media.paused = false;
    media.fire("play");
    media.fire("playing");
  };
  /** Runs the newest pending hide timer. */
  const tick = () => timers.at(-1)?.run();
  /** Runs the newest pending one-second timer: the card's countdown tick. */
  const tickSecond = () =>
    timers
      .filter((timer) => timer.ms === 1000 && !timer.cancelled && !timer.ran)
      .at(-1)
      ?.run();
  return {
    media,
    requests,
    timers,
    player,
    tracks,
    state,
    play,
    tick,
    tickSecond,
  };
}

describe("player state", () => {
  test("follows play and pause on the media, and togglePlay drives it", async () => {
    const { media, player, state } = setup();
    expect(state().playing).toBe(false);

    player.togglePlay();
    await Promise.resolve();
    expect(state().playing).toBe(true);

    media.pause();
    expect(state().playing).toBe(false);
  });

  test("a refused play leaves it paused with the controls up", async () => {
    const { media, player, state } = setup();
    media.refusePlay = true;
    player.togglePlay();
    await Promise.resolve();
    expect(state().playing).toBe(false);
    expect(state().controls).toBe(true);
  });

  test("an ended video restarts from zero", async () => {
    const { media, player, state, play } = setup();
    play();
    media.currentTime = 100;
    media.paused = true;
    media.fire("ended");
    expect(state().ended).toBe(true);

    player.togglePlay();
    await Promise.resolve();
    expect(media.currentTime).toBe(0);
    expect(state().ended).toBe(false);
    expect(state().playing).toBe(true);
  });

  test("seek and skip clamp to the media bounds", () => {
    const { media, player, state } = setup({ startAt: 10 });
    media.duration = 100;

    player.seek(50);
    expect(media.currentTime).toBe(50);
    expect(state().position).toBe(50);

    player.seek(-5);
    expect(media.currentTime).toBe(0);
    player.seek(150);
    expect(media.currentTime).toBe(100);

    player.seek(95);
    player.skip(10);
    expect(media.currentTime).toBe(100);
    player.seek(5);
    player.skip(-10);
    expect(media.currentTime).toBe(0);
  });

  test("duration falls back to the Version's when the media's is NaN", () => {
    const { media, state } = setup();
    expect(state().duration).toBe(100);
    media.duration = 120;
    media.fire("durationchange");
    expect(state().duration).toBe(120);
  });

  test("buffering flags waiting and playing; progress reads the ranges", () => {
    const { media, state, play } = setup();
    media.fire("waiting");
    expect(state().buffering).toBe(true);
    play();
    media.fire("playing");
    expect(state().buffering).toBe(false);

    media.buffered = {
      length: 2,
      start: (i) => [0, 40][i] ?? 0,
      end: (i) => [20, 60][i] ?? 0,
    };
    media.fire("progress");
    expect(state().buffered).toEqual([
      { start: 0, end: 20 },
      { start: 40, end: 60 },
    ]);
  });

  test("an audio choice reopens at the position with the Stream and paused kept", async () => {
    const { media, requests, player, state, play, tracks } = setup();
    play();
    media.fire("playing");
    media.currentTime = 30;
    media.fire("timeupdate");

    const choosing = player.chooseAudio(1);
    expect(state().switching).toBe(true);
    await choosing;
    // The switch ends when the new session's tracks arrive.
    expect(state().switching).toBe(true);
    requests[1]?.onTracks(tracks());
    expect(state().switching).toBe(false);

    expect(requests).toHaveLength(2);
    expect(requests[1]?.startAt).toBe(30);
    expect(requests[1]?.streams.audioStreamIndex).toBe(1);
    expect(requests[1]?.paused).toBe(false);
    expect(requests[0]?.closed).toBe(true);
    // The position holds through the unload until the media reports near it.
    media.currentTime = 0;
    media.fire("timeupdate");
    expect(state().position).toBe(30);
    media.currentTime = 31;
    media.fire("seeked");
    expect(state().position).toBe(31);
  });

  test("a paused viewer stays paused across a switch", async () => {
    const { media, requests, player } = setup();
    media.currentTime = 12;
    await player.chooseAudio(1);
    expect(requests[1]?.paused).toBe(true);
  });

  test("a paused restart buffers until canplay, then shows ready", async () => {
    const { media, player, state } = setup();
    const choosing = player.chooseAudio(1);
    expect(state().buffering).toBe(true);
    await choosing;
    // Paused media never fires `playing`; canplay ends the spinner instead.
    media.fire("canplay");
    expect(state().buffering).toBe(false);
  });

  test("subtitle choices and toggleSubtitles remember the last Stream", async () => {
    const { requests, player, tracks } = setup();
    requests[0]?.onTracks(tracks());

    await player.chooseSubtitles(3);
    expect(requests[1]?.streams.subtitleStreamIndex).toBe(3);
    requests[1]?.onTracks(tracks());
    await player.chooseSubtitles(null);
    expect(requests[2]?.streams.subtitleStreamIndex).toBe(null);

    requests[2]?.onTracks(tracks({ subtitleStreamIndex: 3 }));
    await player.toggleSubtitles();
    expect(requests[3]?.streams.subtitleStreamIndex).toBe(null);
    requests[3]?.onTracks(tracks({ subtitleStreamIndex: null }));
    await player.toggleSubtitles();
    expect(requests[4]?.streams.subtitleStreamIndex).toBe(3);
  });

  test("a Version switch reopens on it with streams reset; the same one is a no-op", async () => {
    const { media, requests, player, state, play } = setup();
    play();
    media.currentTime = 40;
    media.fire("timeupdate");

    await player.chooseVersion("v1");
    expect(requests).toHaveLength(1);

    await player.chooseVersion("v2");
    expect(state().versionId).toBe("v2");
    expect(state().duration).toBe(200);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.versionId).toBe("v2");
    expect(requests[1]?.startAt).toBe(40);
    expect(requests[1]?.streams).toEqual({});
  });

  test("a notice shows and holds the controls; retry reopens and clears it", async () => {
    const { media, requests, player, state, play } = setup();
    play();
    requests[0]?.onNotice({
      title: "Stopped",
      message: "It stalled.",
      retry: true,
    });
    expect(state().notice?.title).toBe("Stopped");
    expect(state().buffering).toBe(false);
    expect(state().controls).toBe(true);

    media.currentTime = 22;
    media.fire("timeupdate");
    await player.retry();
    expect(state().notice).toBeUndefined();
    expect(requests[1]?.startAt).toBe(22);
  });

  test("a switch clears a notice and opens the new choice", async () => {
    const { requests, player, state, play, tracks } = setup();
    play();
    requests[0]?.onNotice({
      title: "Stopped",
      message: "It stalled.",
      retry: false,
    });
    expect(state().notice).toBeDefined();

    await player.chooseVersion("v2");
    expect(state().notice).toBeUndefined();
    expect(requests).toHaveLength(2);
    expect(requests[1]?.versionId).toBe("v2");
    expect(state().versionId).toBe("v2");

    requests[1]?.onNotice({
      title: "Stopped",
      message: "It stalled.",
      retry: false,
    });
    requests[1]?.onTracks(tracks());
    await player.chooseSubtitles(3);
    expect(state().notice).toBeUndefined();
    expect(requests[2]?.streams.subtitleStreamIndex).toBe(3);
  });

  test("a switch clamps the position to the shorter Version", async () => {
    const { media, requests, player, state, play, tracks } = setup({
      versions: [
        { id: "long", durationSeconds: 100 },
        { id: "short", durationSeconds: 60 },
      ],
      versionId: "long",
    });
    play();
    media.duration = 100;
    media.fire("durationchange");
    media.currentTime = 80;
    media.fire("timeupdate");

    await player.chooseVersion("short");
    expect(state().position).toBe(60);
    expect(requests[1]?.versionId).toBe("short");
    expect(requests[1]?.startAt).toBe(60);

    // The media ends at its own edge; switching back does not resume past it.
    requests[1]?.onTracks(tracks());
    media.currentTime = 60;
    media.paused = true;
    media.fire("ended");
    await player.chooseVersion("long");
    expect(requests[2]?.versionId).toBe("long");
    expect(requests[2]?.startAt).toBe(60);
  });

  test("stillness hides playing controls; activity shows them again", async () => {
    const { media, player, state, play, timers } = setup();
    play();
    media.fire("playing");
    player.activity();
    timers.at(-1)?.run();
    expect(state().controls).toBe(false);

    player.activity();
    expect(state().controls).toBe(true);
  });

  test("paused, holds and a notice keep the controls; releasing restarts the timer", () => {
    const { media, player, state, play, timers } = setup();

    player.hold("menu", true);
    play();
    media.fire("playing");
    player.activity();
    timers.at(-1)?.run();
    expect(state().controls).toBe(true);

    player.hold("menu", false);
    expect(state().controls).toBe(true);
    timers.at(-1)?.run();
    expect(state().controls).toBe(false);

    player.hold("pointer", true);
    expect(state().controls).toBe(true);
    player.hold("pointer", false);
    timers.at(-1)?.run();
    expect(state().controls).toBe(false);
  });

  test("toggleControls hides unheld controls and wakes hidden ones", () => {
    const { media, player, state, play } = setup();
    play();
    media.fire("playing");
    player.toggleControls();
    expect(state().controls).toBe(false);
    player.toggleControls();
    expect(state().controls).toBe(true);
  });

  test("volume and mute follow the media rules", () => {
    const { media, player, state } = setup();
    player.setVolume(0.4);
    expect(media.volume).toBe(0.4);
    expect(state().volume).toBe(0.4);

    player.setVolume(0);
    expect(state().muted).toBe(true);
    player.setVolume(0.6);
    expect(state().muted).toBe(false);

    player.toggleMute();
    expect(media.muted).toBe(true);
    media.volume = 0;
    media.fire("volumechange");
    player.toggleMute();
    expect(media.muted).toBe(false);
    expect(media.volume).toBe(0.5);
  });

  test("suspend parks the position and resume reopens there", async () => {
    const { media, requests, player } = setup();
    media.currentTime = 55;
    await player.suspend();
    expect(requests[0]).toBeDefined();
    player.resume();
    expect(requests).toHaveLength(2);
    expect(requests[1]?.startAt).toBe(55);
  });

  test("a Version switch hides the old tracks until the new plan's arrive", async () => {
    const { requests, player, state, tracks } = setup();
    requests[0]?.onTracks(tracks());

    await player.chooseVersion("v2");
    expect(state().switching).toBe(true);
    expect(state().tracks).toBeUndefined();

    // Every restart is refused while the switch is in flight.
    await player.chooseAudio(1);
    await player.chooseSubtitles(3);
    await player.toggleSubtitles();
    await player.retry();
    await player.chooseVersion("v1");
    expect(requests).toHaveLength(2);

    // A late answer from the superseded session is ignored.
    requests[0]?.onTracks(tracks());
    requests[0]?.onNotice({
      title: "Late",
      message: "From the old session.",
      retry: false,
    });
    expect(state().tracks).toBeUndefined();
    expect(state().switching).toBe(true);
    expect(state().notice).toBeUndefined();

    const v2Tracks = tracks({
      audioStreams: [
        { index: 4, title: null, codec: "aac", language: "eng", channels: 2 },
        { index: 5, title: null, codec: "aac", language: "jpn", channels: 6 },
      ],
      subtitleStreams: [
        { index: 6, title: null, codec: "srt", language: "eng", forced: false },
      ],
      audioStreamIndex: 4,
    });
    requests[1]?.onTracks(v2Tracks);
    expect(state().switching).toBe(false);
    expect(state().tracks).toEqual(v2Tracks);

    await player.chooseAudio(5);
    expect(requests[2]?.versionId).toBe("v2");
    expect(requests[2]?.streams.audioStreamIndex).toBe(5);
  });

  test("a failed Version plan ends the switch and keeps the Version menu usable", async () => {
    const { requests, player, state, tracks } = setup();
    requests[0]?.onTracks(tracks());

    await player.chooseVersion("v2");
    requests[1]?.onNotice({
      title: "Cannot play this Version",
      message: "The File is missing.",
      retry: false,
    });
    expect(state().switching).toBe(false);
    expect(state().tracks).toBeUndefined();
    expect(state().notice?.title).toBe("Cannot play this Version");

    await player.chooseVersion("v1");
    expect(requests[2]?.versionId).toBe("v1");
    expect(state().notice).toBeUndefined();
  });

  test("a playing video restores playing after the page cache, and the store agrees", async () => {
    const { media, requests, player, state, tick } = setup(
      {},
      { likeVideo: true },
    );
    await Promise.resolve();
    media.fire("playing");
    media.currentTime = 42;
    media.fire("timeupdate");
    expect(state().playing).toBe(true);

    await player.suspend();
    expect(media.paused).toBe(true);
    expect(state().playing).toBe(false);

    player.resume();
    expect(requests[1]?.paused).toBe(false);
    expect(requests[1]?.startAt).toBe(42);
    await Promise.resolve();
    media.fire("playing");
    expect(media.paused).toBe(false);
    expect(state().playing).toBe(true);
    tick();
    expect(state().controls).toBe(false);
  });

  test("a paused video restores paused after the page cache", async () => {
    const { media, requests, player, state } = setup({}, { likeVideo: true });
    await Promise.resolve();
    media.pause();
    media.currentTime = 42;

    await player.suspend();
    const playCalls = media.playCalls;
    player.resume();
    expect(requests[1]?.paused).toBe(true);
    await Promise.resolve();
    expect(media.paused).toBe(true);
    expect(state().playing).toBe(false);
    expect(state().controls).toBe(true);
    expect(media.playCalls).toBe(playCalls);
  });

  test("a refused autoplay on restore leaves it paused with the controls up", async () => {
    const { media, requests, player, state } = setup({}, { likeVideo: true });
    await Promise.resolve();
    media.fire("playing");
    media.currentTime = 42;

    await player.suspend();
    media.refusePlay = true;
    player.resume();
    expect(requests[1]?.paused).toBe(false);
    await Promise.resolve();
    expect(media.paused).toBe(true);
    expect(state().playing).toBe(false);
    expect(state().controls).toBe(true);
  });

  test("a playing viewer stays playing across a failed Version plan", async () => {
    const { media, requests, player, state } = setup({}, { likeVideo: true });
    await Promise.resolve();
    media.fire("playing");
    media.currentTime = 30;
    media.fire("timeupdate");

    // The plan fails after the old session unloaded the media: paused is
    // clobbered, but the viewer's intent survives.
    media.refusePlay = true;
    await player.chooseVersion("v2");
    expect(requests[1]?.paused).toBe(false);
    requests[1]?.onNotice({
      title: "Cannot play this Version",
      message: "The File is missing.",
      retry: false,
    });
    expect(state().playing).toBe(false);
    expect(media.paused).toBe(true);
    expect(state().controls).toBe(true);

    media.refusePlay = false;
    await player.chooseVersion("v1");
    expect(requests[2]?.paused).toBe(false);
    await Promise.resolve();
    expect(state().playing).toBe(true);
  });

  test("close is safe twice and stops listening", async () => {
    const { media, player, state, play } = setup();
    play();
    media.fire("playing");
    expect(state().buffering).toBe(false);
    await player.close();
    await player.close();
    media.fire("waiting");
    expect(state().buffering).toBe(false);
  });

  test("a quality pick reopens at the position with the rung in the request", async () => {
    const { media, requests, player, state, tracks } = setup();
    requests[0]?.onTracks(tracks());
    media.currentTime = 30;
    media.fire("timeupdate");

    await player.chooseQuality("720p");
    expect(state().quality).toBe("720p");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.quality).toBe("720p");
    expect(requests[1]?.startAt).toBe(30);
  });

  test("a version-sourced quality switches Version and resets streams", async () => {
    const { requests, player, state, tracks } = setup();
    requests[0]?.onTracks(tracks());
    await player.chooseAudio(1);
    requests[1]?.onTracks(tracks());

    await player.chooseQuality("720p", "v2");
    expect(state().versionId).toBe("v2");
    expect(requests).toHaveLength(3);
    expect(requests[2]?.versionId).toBe("v2");
    expect(requests[2]?.quality).toBe("720p");
    expect(requests[2]?.streams).toEqual({});
  });

  test("a stored pick inside the served variants caps locally without a replan", async () => {
    const { requests, player, state, tracks } = setup();
    requests[0]?.onTracks(tracks());

    await player.chooseQuality("1080p");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.capCalls).toEqual([["sv1"]]);
    expect(state().quality).toBe("1080p");

    // Back to Auto lifts the cap in place too.
    await player.chooseQuality("auto");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.capCalls).toEqual([["sv1"], null]);
    expect(state().quality).toBe("auto");
  });

  test("a transcode pick outside the stored variants replans", async () => {
    const { requests, player, tracks } = setup();
    requests[0]?.onTracks(tracks());

    await player.chooseQuality("720p");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.quality).toBe("720p");
    expect(requests[0]?.capCalls).toHaveLength(0);
  });

  test("setSpeed drives the media rates without a restart", async () => {
    const { media, requests, player, state } = setup();
    const count = requests.length;
    player.setSpeed(1.5);
    expect(media.playbackRate).toBe(1.5);
    expect(media.defaultPlaybackRate).toBe(1.5);
    expect(media.preservesPitch).toBe(true);
    expect(state().speed).toBe(1.5);
    expect(requests).toHaveLength(count);
  });

  test("setBoost amplifies over unity without a restart", () => {
    const amplified: number[] = [];
    const { requests, player, state } = setup({
      amplify: (gain) => amplified.push(gain),
    });
    const count = requests.length;
    player.setBoost(2);
    expect(amplified).toEqual([3]);
    expect(state().boost).toBe(2);
    expect(requests).toHaveLength(count);
    player.setBoost(0);
    expect(amplified).toEqual([3, 1]);
  });

  test("stored prefs apply on creation and persist on change", async () => {
    const written: { quality: string; speed: number; boost: number }[] = [];
    const amplified: number[] = [];
    const { media, requests, player, state } = setup({
      prefs: {
        read: () => ({ quality: "720p", speed: 1.5, boost: 2 }),
        write: (prefs) => written.push(prefs),
      },
      amplify: (gain) => amplified.push(gain),
    });
    expect(requests[0]?.quality).toBe("720p");
    expect(media.playbackRate).toBe(1.5);
    expect(media.preservesPitch).toBe(true);
    expect(amplified).toEqual([3]);
    expect(state().quality).toBe("720p");

    player.setSpeed(0.75);
    player.setBoost(0);
    await player.chooseQuality("auto");
    expect(written).toEqual([
      { quality: "720p", speed: 0.75, boost: 2 },
      { quality: "720p", speed: 0.75, boost: 0 },
      { quality: "auto", speed: 0.75, boost: 0 },
    ]);
  });
});

describe("next episode card", () => {
  const withCard = (
    overrides: Partial<Parameters<typeof createPlayer>[0]> = {},
    creditsStartSeconds: number | null = 90,
  ) => {
    let calls = 0;
    const ctx = setup({
      upNext: { autoplay: true },
      onNext: () => {
        calls += 1;
      },
      ...overrides,
    });
    return {
      ...ctx,
      calls: () => calls,
      arrive(seconds = creditsStartSeconds) {
        ctx.requests[0]?.onTracks(ctx.tracks({ creditsStartSeconds }));
        if (seconds !== null) {
          ctx.media.currentTime = seconds;
          ctx.media.fire("timeupdate");
        }
      },
    };
  };

  test("no card without a following Episode", () => {
    const { media, requests, state, tracks, play } = setup();
    play();
    requests[0]?.onTracks(tracks({ creditsStartSeconds: 90 }));
    media.currentTime = 95;
    media.fire("timeupdate");
    media.paused = true;
    media.fire("ended");
    expect(state().upNext).toBeUndefined();
  });

  test("the credits card counts down and moves on with the session completed", () => {
    const { media, requests, state, play, tickSecond, calls, arrive } =
      withCard();
    play();
    arrive(90);
    expect(state().upNext).toEqual({ at: "credits", total: 10, remaining: 10 });
    for (let i = 0; i < 9; i += 1) {
      tickSecond();
      expect(calls()).toBe(0);
    }
    expect(state().upNext?.remaining).toBe(1);
    tickSecond();
    expect(calls()).toBe(1);
    expect(state().upNext).toBeUndefined();
    expect(requests[0]?.closed).toBe(true);
    expect(requests[0]?.closeOptions).toEqual({ completed: true });
    expect(media.paused).toBe(false);
  });

  test("autoplay off shows the credits card without a countdown", () => {
    const { state, play, tickSecond, calls, arrive } = withCard({
      upNext: { autoplay: false },
    });
    play();
    arrive(90);
    expect(state().upNext).toEqual({
      at: "credits",
      total: 10,
      remaining: null,
    });
    tickSecond();
    expect(calls()).toBe(0);
  });

  test("without a chapter the card shows 30 seconds before the end with no countdown", () => {
    const { media, requests, state, play, tracks } = withCard();
    play();
    requests[0]?.onTracks(tracks({ creditsStartSeconds: null }));
    media.currentTime = 69;
    media.fire("timeupdate");
    expect(state().upNext).toBeUndefined();
    media.currentTime = 70;
    media.fire("timeupdate");
    expect(state().upNext).toEqual({
      at: "credits",
      total: 10,
      remaining: null,
    });
  });

  test("a short Video never shows a credits card", () => {
    const { media, requests, state, play, tracks } = setup({
      upNext: { autoplay: true },
      versions: [{ id: "v1", durationSeconds: 20 }],
      versionId: "v1",
    });
    play();
    requests[0]?.onTracks(tracks());
    media.currentTime = 19;
    media.fire("timeupdate");
    expect(state().upNext).toBeUndefined();
  });

  test("seeking back hides the card and it reappears", () => {
    const { media, state, play, arrive } = withCard();
    play();
    arrive(90);
    expect(state().upNext?.at).toBe("credits");
    media.currentTime = 30;
    media.fire("seeked");
    expect(state().upNext).toBeUndefined();
    media.currentTime = 95;
    media.fire("seeked");
    expect(state().upNext?.at).toBe("credits");
  });

  test("pausing halts the countdown and playing resumes it", () => {
    const { media, state, play, tickSecond, calls, arrive } = withCard();
    play();
    arrive(90);
    tickSecond();
    expect(state().upNext?.remaining).toBe(9);
    media.pause();
    for (let i = 0; i < 3; i += 1) tickSecond();
    expect(state().upNext?.remaining).toBe(9);
    play();
    tickSecond();
    expect(state().upNext?.remaining).toBe(8);
    expect(calls()).toBe(0);
  });

  test("a stall holds the credits countdown until playback resumes", () => {
    const { media, state, play, tickSecond, calls, arrive } = withCard();
    play();
    arrive(90);
    tickSecond();
    expect(state().upNext?.remaining).toBe(9);
    media.fire("waiting");
    for (let i = 0; i < 15; i += 1) tickSecond();
    expect(state().upNext?.remaining).toBe(9);
    expect(calls()).toBe(0);
    media.fire("playing");
    tickSecond();
    expect(state().upNext?.remaining).toBe(8);
  });

  test("a session notice holds the credits countdown", () => {
    const { requests, state, play, tickSecond, calls, arrive } = withCard();
    play();
    arrive(90);
    tickSecond();
    expect(state().upNext?.remaining).toBe(9);
    requests[0]?.onNotice({
      title: "Stopped",
      message: "It stalled.",
      retry: true,
    });
    for (let i = 0; i < 15; i += 1) tickSecond();
    expect(state().upNext?.remaining).toBe(9);
    expect(calls()).toBe(0);
  });

  test("Watch credits then ended moves on at once with autoplay", () => {
    const { media, player, state, play, calls, arrive } = withCard();
    play();
    arrive(90);
    player.dismissUpNext();
    expect(state().upNext).toBeUndefined();
    media.paused = true;
    media.ended = true;
    media.fire("ended");
    expect(calls()).toBe(1);
  });

  test("Watch credits then ended shows the end card without a countdown when autoplay is off", () => {
    const { media, player, state, play, calls, arrive } = withCard({
      upNext: { autoplay: false },
    });
    play();
    arrive(90);
    player.dismissUpNext();
    media.paused = true;
    media.ended = true;
    media.fire("ended");
    expect(state().upNext).toEqual({ at: "end", total: 5, remaining: null });
    expect(calls()).toBe(0);
  });

  test("ended without a card counts down 5 seconds then moves on", () => {
    const { media, requests, state, play, tracks, tickSecond, calls } =
      withCard();
    play();
    requests[0]?.onTracks(tracks({ creditsStartSeconds: null }));
    // Ended before the fallback trigger position matters: ended wins.
    media.currentTime = 10;
    media.paused = true;
    media.fire("ended");
    expect(state().upNext).toEqual({ at: "end", total: 5, remaining: 5 });
    for (let i = 0; i < 4; i += 1) {
      tickSecond();
      expect(calls()).toBe(0);
    }
    tickSecond();
    expect(calls()).toBe(1);
    expect(state().ended).toBe(true);
  });

  test("Cancel on the end card leaves the player ended", () => {
    const { media, player, state, play, requests, tracks, tickSecond, calls } =
      withCard();
    play();
    requests[0]?.onTracks(tracks({ creditsStartSeconds: null }));
    media.paused = true;
    media.ended = true;
    media.fire("ended");
    player.dismissUpNext();
    expect(state().upNext).toBeUndefined();
    for (let i = 0; i < 6; i += 1) tickSecond();
    expect(calls()).toBe(0);
    expect(state().ended).toBe(true);
  });

  test("a running credits countdown moves on the moment the media ends", () => {
    const { media, state, play, calls, arrive } = withCard();
    play();
    arrive(90);
    media.paused = true;
    media.ended = true;
    media.fire("ended");
    expect(calls()).toBe(1);
    expect(state().upNext).toBeUndefined();
  });

  test("leaving ended hides the end card and clears its dismissal", () => {
    const { media, player, state, play, requests, tracks } = withCard();
    play();
    requests[0]?.onTracks(tracks({ creditsStartSeconds: null }));
    media.paused = true;
    media.ended = true;
    media.fire("ended");
    player.dismissUpNext();
    player.seek(0);
    media.ended = false;
    play();
    expect(state().upNext).toBeUndefined();
    media.paused = true;
    media.ended = true;
    media.fire("ended");
    expect(state().upNext?.at).toBe("end");
  });

  test("the initial streams option reaches the first session request", () => {
    const { requests } = setup({
      streams: { audioStreamIndex: 1, subtitleStreamIndex: 3 },
    });
    expect(requests[0]?.streams).toEqual({
      audioStreamIndex: 1,
      subtitleStreamIndex: 3,
    });
  });
});
