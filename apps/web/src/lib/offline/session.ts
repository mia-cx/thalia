import type { DownloadStream } from "../downloads/index.ts";
import {
  cannotPlay,
  type PlannedTracks,
  type PlayerNotice,
  type StreamChoice,
  stalled,
} from "../player.ts";
import { attachProgressive } from "../progressive.ts";
import { browserDecodes, offlinePlan } from "./playable.ts";

/** One offline playback attempt: a download's File on a video element. */
export type DownloadPlayback = {
  video: HTMLVideoElement;
  /** The download's probed Streams, from its record. */
  streams: readonly DownloadStream[];
  /** Reads the downloaded File. */
  file: () => Promise<Blob>;
  /** Where to start, in seconds; null starts at the beginning. */
  startAt: number | null;
  /** Starts loaded but paused, so a paused viewer stays paused across a switch. */
  paused?: boolean;
  choice: StreamChoice;
  onNotice: (notice: PlayerNotice) => void;
  onTracks: (tracks: PlannedTracks) => void;
};

/** The tracks menu of a download: its Streams and the ones playing. */
function downloadTracks(
  streams: readonly DownloadStream[],
  audioStreamIndex: number | null,
): PlannedTracks {
  return {
    audioStreams: streams
      .filter((stream) => stream.kind === "audio")
      .map(({ index, codec, channels, language, title }) => ({
        index,
        codec,
        channels,
        language,
        title,
      })),
    subtitleStreams: [],
    audioStreamIndex,
    subtitleStreamIndex: null,
    creditsStartSeconds: null,
    quality: { original: null, rungs: [], storedVariantIds: [] },
  };
}

/**
 * Plays a download from browser storage with no server: the File is remuxed
 * to fragmented MP4 in the page and fed through Media Source Extensions. A
 * download this browser can't play reports why instead.
 */
export function playDownload(options: DownloadPlayback): {
  close(): Promise<void>;
} {
  const { video, streams, onNotice } = options;
  const events = new AbortController();
  let closing = false;
  let progressive: { close(): void } | undefined;
  let release: (() => void) | undefined;

  const refuse = (message: string) => {
    if (!closing) onNotice({ title: cannotPlay, message, retry: false });
  };

  async function open() {
    const plan = offlinePlan(
      streams,
      browserDecodes,
      options.choice.audioStreamIndex,
    );
    const asked = options.choice.audioStreamIndex ?? null;
    options.onTracks(
      downloadTracks(streams, "reason" in plan ? asked : plan.audioStreamIndex),
    );
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
    const remux = await openRemux(await options.file());
    release = () => remux.dispose();
    if (closing) return;
    const mime = await remux.mime(audio);
    if (closing) return;
    if (!browserDecodes(mime)) {
      refuse("This browser can't play this download.");
      return;
    }
    video.addEventListener("error", () => onNotice(stalled), {
      signal: events.signal,
    });
    progressive = attachProgressive(video, {
      openRun: async (start) => ({ body: remux.run(start, audio), offset: 0 }),
      mime,
      durationSeconds: remux.durationSeconds,
      startAt: options.startAt ?? 0,
      onError: () => onNotice(stalled),
    });
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
    /** Stops the remux and releases the video element. Safe to call twice. */
    async close() {
      if (closing) return;
      closing = true;
      events.abort();
      progressive?.close();
      video.removeAttribute("src");
      video.load();
      await opened;
      release?.();
    },
  };
}
