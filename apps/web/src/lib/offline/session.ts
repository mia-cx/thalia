import type { DownloadRecord } from "../downloads/index.ts";
import {
  cannotPlay,
  heartbeatMs,
  type PlannedTracks,
  type PlayerNotice,
  type StreamChoice,
  stalled,
} from "../player.ts";
import { attachProgressive } from "../progressive.ts";
import { browserDecodes, offlinePlan } from "./playable.ts";
import type { SubtitleSource } from "./subtitles.ts";

/** One offline playback attempt: a download's File on a video element. */
export type DownloadPlayback = {
  video: HTMLVideoElement;
  /** The download to play. */
  record: Pick<
    DownloadRecord,
    "versionId" | "container" | "streams" | "subtitles"
  >;
  /** Reads one of the download's files: the media by Version id, a subtitle by name. */
  file: (name: string) => Promise<Blob>;
  /** The Version's probed length; reported positions never pass it. */
  durationSeconds: number | null;
  /** Where to start, in seconds; null starts at the beginning. */
  startAt: number | null;
  /** Starts loaded but paused, so a paused viewer stays paused across a switch. */
  paused?: boolean;
  choice: StreamChoice;
  onNotice: (notice: PlayerNotice) => void;
  onTracks: (tracks: PlannedTracks) => void;
  /** Takes the position while playing, on pause, at the end and on close; absent records nothing. */
  onProgress?: (progress: {
    positionSeconds: number;
    completed: boolean;
  }) => void;
};

type SubtitleOption = PlannedTracks["subtitleStreams"][number] & {
  source: (file: DownloadPlayback["file"]) => Promise<SubtitleSource>;
};

// Embedded subtitle codecs drawn offline, by the probe's names: text, ASS and images.
const drawnCodecs = new Set([
  "subrip",
  "ass",
  "ssa",
  "webvtt",
  "hdmv_pgs_subtitle",
  "dvd_subtitle",
]);

/**
 * The subtitles a download offers: its Matroska text, ASS and image tracks, then
 * the stored files saved with it, numbered past every embedded Stream.
 */
function subtitleOptions(record: DownloadPlayback["record"]): SubtitleOption[] {
  const embedded = record.streams.filter(
    (stream) => stream.kind === "subtitle",
  );
  const matroska = record.container?.match(/mkv|matroska|webm/) != null;
  const next =
    Math.max(-1, ...record.streams.map((stream) => stream.index)) + 1;
  return [
    ...embedded.flatMap((stream, position) =>
      matroska && drawnCodecs.has(stream.codec)
        ? [
            {
              index: stream.index,
              codec: stream.codec,
              language: stream.language,
              title: stream.title,
              forced: stream.forced,
              source: async (file: DownloadPlayback["file"]) => ({
                kind: "embedded" as const,
                file: await file(record.versionId),
                position,
                forced: stream.forced,
              }),
            },
          ]
        : [],
    ),
    ...record.subtitles.map((track, offset) => ({
      index: next + offset,
      codec: track.format,
      language: track.language,
      title: null,
      forced: track.forced,
      source: async (file: DownloadPlayback["file"]) => ({
        kind: "file" as const,
        file: await file(track.name),
        format: track.format,
      }),
    })),
  ];
}

/**
 * Plays a download from browser storage with no server: the File is remuxed
 * to fragmented MP4 in the page and fed through Media Source Extensions, and
 * the chosen subtitles are drawn over it. Progress goes to `onProgress` on
 * the online player's cadence. A download this browser can't play reports
 * why instead.
 */
export function playDownload(options: DownloadPlayback): {
  close(options?: { completed?: boolean }): Promise<void>;
} {
  const { video, record, onNotice } = options;
  const { streams } = record;
  const events = new AbortController();
  let closing = false;
  let progressive: { close(): void } | undefined;
  const releases: (() => void)[] = [];
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  // As online, only a session that started playing has progress to record.
  let started = false;

  const position = () =>
    options.durationSeconds === null
      ? video.currentTime
      : Math.min(video.currentTime, options.durationSeconds);

  const report = (completed = video.ended) => {
    if (started)
      options.onProgress?.({ positionSeconds: position(), completed });
  };

  const on = (type: keyof HTMLMediaElementEventMap, listener: () => void) =>
    video.addEventListener(type, listener, { signal: events.signal });

  const refuse = (message: string) => {
    if (!closing) onNotice({ title: cannotPlay, message, retry: false });
  };

  const subtitles = subtitleOptions(record);
  // Unless the viewer chose, a forced track shows and others wait to be asked.
  const shownSubtitle =
    options.choice.subtitleStreamIndex === undefined
      ? subtitles.find((option) => option.forced)
      : subtitles.find(
          (option) => option.index === options.choice.subtitleStreamIndex,
        );

  async function showSubtitle() {
    if (shownSubtitle === undefined) return;
    try {
      const source = await shownSubtitle.source(options.file);
      const { showSubtitles } = await import("./subtitles.ts");
      if (closing) return;
      const shown = await showSubtitles(video, source);
      if (closing) shown.close();
      else releases.push(() => shown.close());
    } catch (error) {
      // Playback goes on without them.
      console.error(error);
    }
  }

  async function open() {
    const plan = offlinePlan(
      streams,
      browserDecodes,
      options.choice.audioStreamIndex,
    );
    const asked = options.choice.audioStreamIndex ?? null;
    options.onTracks({
      audioStreams: streams
        .filter((stream) => stream.kind === "audio")
        .map(({ index, codec, channels, language, title }) => ({
          index,
          codec,
          channels,
          language,
          title,
        })),
      subtitleStreams: subtitles.map(({ source: _, ...option }) => option),
      audioStreamIndex: "reason" in plan ? asked : plan.audioStreamIndex,
      subtitleStreamIndex: shownSubtitle?.index ?? null,
      creditsStartSeconds: null,
      quality: { original: null, rungs: [], storedVariantIds: [] },
    });
    if ("reason" in plan) {
      refuse(`${plan.reason}.`);
      return;
    }
    // The n-th audio Stream of the probe is the n-th audio track of the File.
    const audio =
      plan.audioStreamIndex === null
        ? null
        : streams
            .filter((stream) => stream.kind === "audio")
            .findIndex((stream) => stream.index === plan.audioStreamIndex);
    // Mediabunny loads only when a download plays.
    const { openRemux } = await import("./remux.ts");
    const remux = await openRemux(await options.file(record.versionId));
    releases.push(() => remux.dispose());
    if (closing) return;
    const prepared = await remux.prepare(audio, plan.convert);
    if (closing) return;
    if (!browserDecodes(prepared.mime)) {
      refuse("This browser can't play this download.");
      return;
    }
    on("error", () => onNotice(stalled));
    on("playing", () => {
      started = true;
    });
    on("pause", () => {
      if (!video.ended) report();
    });
    on("ended", () => report());
    heartbeat = setInterval(() => {
      if (!video.paused) report();
    }, heartbeatMs);
    progressive = attachProgressive(video, {
      openRun: async (start) => ({ body: prepared.run(start), offset: 0 }),
      mime: prepared.mime,
      durationSeconds: remux.durationSeconds,
      startAt: options.startAt ?? 0,
      onError: () => onNotice(stalled),
    });
    void showSubtitle();
    if (!options.paused)
      void video.play().catch(() => {
        // The browser refused autoplay; the controls stay ready for a click.
      });
  }

  const opened = open().catch((error: unknown) => {
    console.error(error);
    refuse("Thalia can't read this download.");
  });

  return {
    /** Records the last position, stops the remux and subtitles and releases the video element. `completed` marks it watched; safe to call twice. */
    async close(close?: { completed?: boolean }) {
      if (closing) return;
      report(close?.completed === true || video.ended);
      closing = true;
      clearInterval(heartbeat);
      events.abort();
      progressive?.close();
      video.removeAttribute("src");
      video.load();
      await opened;
      for (const release of releases) release();
    },
  };
}
