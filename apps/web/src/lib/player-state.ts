import { type Readable, writable } from "svelte/store";
import type { PlannedTracks, PlayerNotice, StreamChoice } from "./player.ts";
import type { PrefsStore } from "./player-prefs.ts";

/** The parts of a video element the player reads and drives; an HTMLVideoElement fits. */
export type Media = Pick<
  EventTarget,
  "addEventListener" | "removeEventListener"
> & {
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly readyState: number;
  volume: number;
  muted: boolean;
  playbackRate: number;
  defaultPlaybackRate: number;
  preservesPitch: boolean;
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly buffered: {
    readonly length: number;
    start(index: number): number;
    end(index: number): number;
  };
  play(): Promise<void>;
  pause(): void;
};

/** What the player asks of one playback session. */
export type SessionRequest = {
  versionId: string;
  /** Seconds; null resumes where the viewer left off. */
  startAt: number | null;
  streams: StreamChoice;
  /** The quality menu's choice sent to the plan. */
  quality: string;
  /** Load without starting playback, so a paused viewer stays paused across a switch. */
  paused: boolean;
  onNotice: (notice: PlayerNotice) => void;
  onTracks: (tracks: PlannedTracks) => void;
};

/** One opened playback session. */
export type Session = {
  /** `completed: true` marks the Item watched in the stop report. */
  close(options?: { completed?: boolean }): Promise<void>;
  /** Caps ABR within the session's stored variants without a replan; null clears. */
  capLevels?(variantIds: readonly string[] | null): boolean;
};

/** Opens a session on the media; the browser passes `play` from player.ts. */
export type OpenSession = (request: SessionRequest) => Session;

/** Why the controls stay up regardless of stillness. */
export type Hold = "menu" | "focus" | "pointer";

export type PlayerState = {
  versionId: string;
  /** The media is playing. */
  playing: boolean;
  ended: boolean;
  /** Waiting for data, or a session starting or restarting. */
  buffering: boolean;
  position: number;
  /** The media's duration, else the Version's probed one, else 0. */
  duration: number;
  buffered: readonly { start: number; end: number }[];
  volume: number;
  muted: boolean;
  tracks: PlannedTracks | undefined;
  /** A restart or Version switch is in flight; menus disable. */
  switching: boolean;
  notice: PlayerNotice | undefined;
  /** The quality menu's choice. */
  quality: string;
  /** The playing frame size, from the media's metadata; null before it loads. */
  videoSize: { width: number; height: number } | null;
  /** The playback rate the viewer picked. */
  speed: number;
  /** The extra gain applied over unity; 0 is Off. */
  boost: number;
  /** Whether the controls show. */
  controls: boolean;
  /** The Next episode card: where it showed up, and while counting down the whole seconds left of `total`. */
  upNext:
    | { at: "credits" | "end"; remaining: number | null; total: number }
    | undefined;
};

const resumeToleranceSeconds = 2;
// HTMLMediaElement.HAVE_FUTURE_DATA: enough is loaded to keep playing.
const haveFutureData = 3;

/** One playback session and its chrome: transport, tracks, notices and auto-hiding controls. */
export function createPlayer(options: {
  media: Media;
  versions: readonly { id: string; durationSeconds: number | null }[];
  versionId: string;
  startAt: number | null;
  open: OpenSession;
  /** An Episode follows this one; `autoplay` counts the card down. Absent or null plays no card. */
  upNext?: { autoplay: boolean } | null;
  /** Runs once when the player moves on; the session close as completed has already started. */
  onNext?: () => void;
  /** The Streams the first session plays; the server picks what is absent. */
  streams?: StreamChoice;
  /** Remembers quality, speed and boost on the device. */
  prefs?: PrefsStore;
  /** Applies a volume boost as a gain level over unity; 1 is Off. */
  amplify?: (gain: number) => void;
  /** Stillness before the controls hide; default 3000 ms. */
  hideAfterMs?: number;
  /** Runs `run` after `ms` and returns a cancel; tests pass a manual clock. Default wraps setTimeout. */
  schedule?: (run: () => void, ms: number) => () => void;
}) {
  const { media, open } = options;
  const hideAfterMs = options.hideAfterMs ?? 3000;
  const schedule =
    options.schedule ??
    ((run: () => void, ms: number) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    });

  const initialVersion =
    options.versions.find((version) => version.id === options.versionId) ??
    options.versions[0];
  const stored = options.prefs?.read();
  let quality = stored?.quality ?? "auto";
  let speed = stored?.speed ?? 1;
  let boost = stored?.boost ?? 0;
  /** The quality the open session was planned with; a local cap may follow. */
  let sessionPlanned = quality;
  /** The current session's levels are capped below the viewer's pick. */
  let locallyCapped = false;
  const store = writable<PlayerState>({
    versionId: initialVersion?.id ?? options.versionId,
    playing: false,
    ended: false,
    buffering: true,
    position: options.startAt ?? 0,
    duration: initialVersion?.durationSeconds ?? 0,
    buffered: [],
    volume: media.volume,
    muted: media.muted,
    tracks: undefined,
    switching: false,
    notice: undefined,
    quality,
    videoSize: null,
    speed,
    boost,
    controls: true,
    upNext: undefined,
  });
  const state = { subscribe: store.subscribe } satisfies Readable<PlayerState>;
  const patch = (part: Partial<PlayerState>) =>
    store.update((state) => ({ ...state, ...part }));
  let current!: PlayerState;
  store.subscribe((next) => (current = next));

  const holds = new Set<Hold>();
  let streams: StreamChoice = options.streams ?? {};
  /** The subtitle Stream index C toggles back on. */
  let subtitlesOff: number | null = null;
  let session: Session | undefined;
  let closed = false;
  let suspended = false;
  let suspendedAt: number | null = null;
  let suspendedPlaying = false;
  /** The viewer's play intent, set only by real play/pause/ended events; teardown resets media.paused silently. */
  let wantsPlaying = false;
  /** Bumped per session; a superseded session's callbacks no-op. */
  let generation = 0;
  /** During a restart the media unloads; position reports pin to `at`. */
  let positionHold: number | null = null;
  let hideCancel: (() => void) | undefined;
  let hideTimerOn = false;
  /** Where the credits start, from the session's plan; a Version switch refreshes it. */
  let creditsStart: number | null = null;
  let creditsDismissed = false;
  let endDismissed = false;
  let tickCancel: (() => void) | undefined;
  let movingOn = false;

  function versionDuration() {
    return (
      options.versions.find((version) => version.id === current.versionId)
        ?.durationSeconds ?? 0
    );
  }

  function readDuration() {
    return Number.isFinite(media.duration) && media.duration > 0
      ? media.duration
      : versionDuration();
  }

  function readBuffered() {
    const ranges: { start: number; end: number }[] = [];
    for (let index = 0; index < media.buffered.length; index += 1)
      ranges.push({
        start: media.buffered.start(index),
        end: media.buffered.end(index),
      });
    return ranges;
  }

  /** Paused, ended, a notice or a hold keeps the controls up. */
  function heldUp() {
    return (
      suspended ||
      !current.playing ||
      current.ended ||
      current.notice !== undefined ||
      holds.size > 0
    );
  }

  function cancelHide() {
    hideTimerOn = false;
    hideCancel?.();
    hideCancel = undefined;
  }

  /** Applies the controls rule: held up shows, stillness hides. */
  function settleControls() {
    if (heldUp()) {
      cancelHide();
      if (!current.controls) patch({ controls: true });
      return;
    }
    if (!current.controls || hideTimerOn) return;
    hideTimerOn = true;
    hideCancel = schedule(() => {
      hideTimerOn = false;
      hideCancel = undefined;
      if (!heldUp()) patch({ controls: false });
    }, hideAfterMs);
  }

  function cancelCountdown() {
    tickCancel?.();
    tickCancel = undefined;
  }

  function tickCountdown() {
    tickCancel = undefined;
    const upNext = current.upNext;
    if (upNext?.remaining == null) return;
    const remaining = upNext.remaining - 1;
    if (remaining <= 0) {
      advance();
      return;
    }
    patch({ upNext: { ...upNext, remaining } });
    tickCancel = schedule(tickCountdown, 1000);
  }

  function armCountdown() {
    tickCancel ??= schedule(tickCountdown, 1000);
  }

  /** Closes the session as watched and hands over to the next Episode. */
  function advance() {
    if (movingOn || closed) return;
    movingOn = true;
    cancelCountdown();
    patch({ upNext: undefined });
    void session?.close({ completed: true });
    options.onNext?.();
  }

  /** Re-evaluates the Next episode card against the position, ended and the viewer's dismissals. */
  function evaluateUpNext() {
    const choice = options.upNext;
    if (closed || movingOn || choice === null || choice === undefined) {
      cancelCountdown();
      return;
    }
    const autoplay = choice.autoplay;
    const card = current.upNext;
    if (current.ended) {
      // A running credits countdown or a chosen Watch credits moves on now.
      if (
        (card?.at === "credits" && card.remaining !== null) ||
        (creditsDismissed && autoplay)
      ) {
        advance();
        return;
      }
      if (endDismissed) {
        if (card !== undefined) patch({ upNext: undefined });
        cancelCountdown();
        return;
      }
      if (card?.at !== "end") {
        patch({
          upNext: { at: "end", total: 5, remaining: autoplay ? 5 : null },
        });
      }
      // The media is ended: the end countdown ticks regardless of paused.
      if (current.upNext?.remaining !== null) armCountdown();
      return;
    }
    // Leaving ended (a seek or replay) retires the end card and its dismissal.
    if (card?.at === "end") patch({ upNext: undefined });
    endDismissed = false;
    const duration = readDuration();
    const trigger = creditsStart ?? (duration > 30 ? duration - 30 : null);
    const position = positionHold ?? current.position;
    // Seeking back before the trigger retires the card and its dismissal.
    if (trigger === null || position < trigger) {
      if (current.upNext?.at === "credits") patch({ upNext: undefined });
      creditsDismissed = false;
      cancelCountdown();
      return;
    }
    if (creditsDismissed) {
      cancelCountdown();
      return;
    }
    // Between a Version switch and its plan there is no card to show; onTracks
    // rebuilds it from the new mode.
    if (current.tracks === undefined) {
      cancelCountdown();
      return;
    }
    if (current.upNext === undefined) {
      patch({
        upNext: {
          at: "credits",
          total: 10,
          remaining: creditsStart !== null && autoplay ? 10 : null,
        },
      });
    }
    // Credits count down only while playback runs free; pausing, buffering
    // or a notice holds them.
    if (
      current.upNext?.remaining !== null &&
      current.playing &&
      !current.buffering &&
      current.notice === undefined
    )
      armCountdown();
    else cancelCountdown();
  }

  function openSession(
    versionId: string,
    startAt: number | null,
    nextStreams: StreamChoice,
    paused: boolean,
  ) {
    const mine = ++generation;
    sessionPlanned = quality;
    locallyCapped = false;
    session = open({
      versionId,
      startAt,
      streams: nextStreams,
      quality,
      paused,
      onNotice: (notice) => {
        if (mine !== generation) return;
        patch({
          notice,
          buffering: false,
          switching: false,
          playing: !media.paused,
        });
        evaluateUpNext();
        settleControls();
      },
      onTracks: (tracks) => {
        if (mine !== generation) return;
        creditsStart = tracks.creditsStartSeconds;
        patch({ tracks, switching: false });
        evaluateUpNext();
      },
    });
  }

  function updatePosition(time: number) {
    if (
      positionHold !== null &&
      Math.abs(time - positionHold) > resumeToleranceSeconds
    )
      return;
    positionHold = null;
    patch({ position: time });
  }

  function readSize() {
    patch({
      videoSize:
        media.videoWidth > 0
          ? { width: media.videoWidth, height: media.videoHeight }
          : null,
    });
  }

  const listeners: [string, () => void][] = [
    [
      "play",
      () => {
        wantsPlaying = true;
        patch({ playing: true, ended: false });
        evaluateUpNext();
      },
    ],
    [
      "pause",
      () => {
        wantsPlaying = false;
        patch({ playing: false, buffering: false });
        evaluateUpNext();
        settleControls();
      },
    ],
    [
      "ended",
      () => {
        wantsPlaying = false;
        // The media may end short of the metadata duration; release the hold.
        positionHold = null;
        patch({
          playing: false,
          ended: true,
          buffering: false,
          position: media.currentTime,
        });
        evaluateUpNext();
        settleControls();
      },
    ],
    [
      "waiting",
      () => {
        patch({ buffering: true });
        evaluateUpNext();
      },
    ],
    // A paused load or a refused autoplay never fires `playing`.
    [
      "canplay",
      () => {
        if (media.paused) patch({ buffering: false });
      },
    ],
    [
      "playing",
      () => {
        patch({ buffering: false });
        evaluateUpNext();
        settleControls();
      },
    ],
    [
      "timeupdate",
      () => {
        // Browsers don't always fire `playing` after a stall clears, so
        // moving time with data ready ends the spinner too.
        if (
          current.buffering &&
          !media.paused &&
          media.readyState >= haveFutureData
        )
          patch({ buffering: false });
        updatePosition(media.currentTime);
        evaluateUpNext();
      },
    ],
    [
      "seeked",
      () => {
        updatePosition(media.currentTime);
        evaluateUpNext();
      },
    ],
    [
      "durationchange",
      () => {
        patch({ duration: readDuration() });
        evaluateUpNext();
      },
    ],
    ["loadedmetadata", readSize],
    ["resize", readSize],
    ["progress", () => patch({ buffered: readBuffered() })],
    ["volumechange", () => patch({ volume: media.volume, muted: media.muted })],
  ];
  for (const [type, listener] of listeners)
    media.addEventListener(type, listener);

  /** Closes the session and opens a new one at the position it stopped at. */
  async function restart(
    versionId: string,
    nextStreams: StreamChoice,
  ): Promise<void> {
    if (current.switching || closed || suspended) return;
    const changingVersion = versionId !== current.versionId;
    const target =
      options.versions.find((version) => version.id === versionId)
        ?.durationSeconds ?? 0;
    const now = positionHold ?? media.currentTime;
    const at = target > 0 ? Math.min(now, target) : now;
    const paused = !wantsPlaying;
    positionHold = at;
    patch({
      switching: true,
      buffering: true,
      notice: undefined,
      versionId,
      position: at,
      // A different Version brings different Streams; the old ones are invalid.
      tracks: changingVersion ? undefined : current.tracks,
    });
    if (changingVersion) {
      creditsStart = null;
      creditsDismissed = false;
      endDismissed = false;
      cancelCountdown();
      if (current.upNext?.at === "credits") patch({ upNext: undefined });
    }
    evaluateUpNext();
    settleControls();
    await session?.close();
    if (closed) return;
    openSession(versionId, at, nextStreams, paused);
    patch({ duration: versionDuration() });
    settleControls();
  }

  /** Wakes the controls and restarts the stillness timer. */
  function activity() {
    if (!current.controls) patch({ controls: true });
    cancelHide();
    settleControls();
  }

  const persist = () => options.prefs?.write({ quality, speed, boost });

  // Stored prefs apply to this media and the first session's plan.
  media.defaultPlaybackRate = speed;
  media.playbackRate = speed;
  media.preservesPitch = true;
  if (boost > 0) options.amplify?.(1 + boost);
  openSession(current.versionId, options.startAt, streams, false);
  settleControls();

  const api = {
    state,
    /** Plays a paused or ended video (ended starts over), pauses a playing one. */
    togglePlay() {
      activity();
      if (current.ended) {
        api.seek(0);
        void media.play().catch(() => {});
      } else if (media.paused) {
        void media.play().catch(() => {
          // The browser refused; stay paused with the controls up.
        });
      } else {
        media.pause();
      }
    },
    /** Jumps to an absolute position clamped to the media's bounds. */
    seek(seconds: number) {
      activity();
      const to = Math.min(Math.max(0, seconds), readDuration());
      positionHold = null;
      media.currentTime = to;
      patch({ position: to, ended: false });
    },
    /** Jumps relative to the current position. */
    skip(seconds: number) {
      api.seek(current.position + seconds);
    },
    /** Sets the volume clamped to 0..1; zero mutes, raising unmutes. */
    setVolume(volume: number) {
      activity();
      const next = Math.min(Math.max(0, volume), 1);
      media.volume = next;
      media.muted = next === 0;
      patch({ volume: next, muted: next === 0 });
    },
    /** Flips mute; unmuting at zero volume restores half volume. */
    toggleMute() {
      activity();
      const muted = !media.muted;
      media.muted = muted;
      if (!muted && media.volume === 0) media.volume = 0.5;
      patch({ muted, volume: media.volume });
    },
    /** Plays the audio Stream at `index`, restarting the session in place. */
    async chooseAudio(index: number) {
      activity();
      streams = { ...streams, audioStreamIndex: index };
      await restart(current.versionId, streams);
    },
    /** Plays the subtitle Stream at `index`, or none when null. */
    async chooseSubtitles(index: number | null) {
      activity();
      streams = { ...streams, subtitleStreamIndex: index };
      await restart(current.versionId, streams);
    },
    /** Toggles subtitles off and back to the last or first Stream. */
    async toggleSubtitles() {
      activity();
      const tracks = current.tracks;
      if (tracks === undefined || tracks.subtitleStreams.length === 0) return;
      if (tracks.subtitleStreamIndex !== null) {
        subtitlesOff = tracks.subtitleStreamIndex;
        await api.chooseSubtitles(null);
        return;
      }
      await api.chooseSubtitles(
        subtitlesOff ?? tracks.subtitleStreams[0]?.index ?? null,
      );
    },
    /** Switches Versions at the same position; streams reset per File. */
    async chooseVersion(id: string) {
      activity();
      if (id === current.versionId || current.switching) return;
      streams = {};
      subtitlesOff = null;
      await restart(id, streams);
    },
    /** Picks a quality: caps locally inside a stored session when possible, else replans at the position. */
    async chooseQuality(choice: string, versionId?: string) {
      activity();
      if (current.switching) return;
      const switchingVersion =
        versionId !== undefined && versionId !== current.versionId;
      if (!switchingVersion && sessionPlanned === "auto") {
        const rung = current.tracks?.quality.rungs.find(
          (option) => option.name === choice,
        );
        const served = current.tracks?.quality.storedVariantIds ?? [];
        const capped =
          choice === "auto"
            ? locallyCapped && (session?.capLevels?.(null) ?? false)
            : rung?.source === "stored" &&
              rung.storedVariantIds.every((id) => served.includes(id)) &&
              (session?.capLevels?.(rung.storedVariantIds) ?? false);
        if (capped) {
          locallyCapped = choice !== "auto";
          quality = choice;
          persist();
          patch({ quality: choice });
          return;
        }
      }
      quality = choice;
      persist();
      patch({ quality: choice });
      if (switchingVersion) {
        // A different Version brings different Streams; the old ones are invalid.
        streams = {};
        subtitlesOff = null;
      }
      await restart(versionId ?? current.versionId, streams);
    },
    /** Sets the playback rate without a replan; survives session reloads. */
    setSpeed(rate: number) {
      activity();
      speed = rate;
      persist();
      media.defaultPlaybackRate = rate;
      media.playbackRate = rate;
      media.preservesPitch = true;
      patch({ speed: rate });
    },
    /** Sets the extra volume gain over unity; 0 is Off. */
    setBoost(level: number) {
      activity();
      boost = level;
      persist();
      options.amplify?.(1 + level);
      patch({ boost: level });
    },
    /** Reopens the session at the current position after a notice. */
    async retry() {
      activity();
      await restart(current.versionId, streams);
    },
    /** Wakes the controls and restarts the stillness timer. */
    activity,
    /** Touch tap: hides unheld controls, else wakes them. */
    toggleControls() {
      if (current.controls && !heldUp()) {
        cancelHide();
        patch({ controls: false });
        return;
      }
      activity();
    },
    /** Adds or releases a reason the controls stay up. */
    hold(reason: Hold, held: boolean) {
      if (held) holds.add(reason);
      else holds.delete(reason);
      settleControls();
    },
    /** Moves on to the next Episode now; the card's Play button and the countdown call it. */
    playNext() {
      advance();
    },
    /** Watch credits on the credits card; Cancel or Close on the end card. */
    dismissUpNext() {
      const upNext = current.upNext;
      if (upNext === undefined) return;
      cancelCountdown();
      if (upNext.at === "credits") creditsDismissed = true;
      else endDismissed = true;
      patch({ upNext: undefined });
    },
    /** pagehide: parks the position and stops the session. */
    async suspend() {
      if (suspended || closed) return;
      suspended = true;
      suspendedAt = positionHold ?? media.currentTime;
      // Teardown may queue a `pause`; the intent is read before it.
      suspendedPlaying = wantsPlaying;
      const closing = session;
      session = undefined;
      generation += 1;
      await closing?.close();
      // Closing unloads the media without a `pause` event; reconcile the store.
      if (!closed) {
        patch({ playing: !media.paused, buffering: false });
        settleControls();
      }
    },
    /** pageshow from the back/forward cache: reopens where it stopped. */
    resume() {
      if (!suspended || closed) return;
      suspended = false;
      openSession(current.versionId, suspendedAt, streams, !suspendedPlaying);
      settleControls();
    },
    /** Stops the session, media listeners and the timer. Safe to call twice. */
    async close() {
      if (closed) return;
      closed = true;
      cancelHide();
      cancelCountdown();
      for (const [type, listener] of listeners)
        media.removeEventListener(type, listener);
      const closing = session;
      session = undefined;
      generation += 1;
      await closing?.close();
    },
  };
  return api;
}
