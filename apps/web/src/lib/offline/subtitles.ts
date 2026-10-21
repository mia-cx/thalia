import { openMatroskaSubtitles, type SubtitleBlock } from "./matroska.ts";

/** The subtitles to draw: an embedded track of the File, or a subtitle file saved with the download. */
export type SubtitleSource =
  | {
      kind: "embedded";
      file: Blob;
      /** The track's place among the File's subtitle tracks. */
      position: number;
    }
  | { kind: "file"; file: Blob; format: "srt" | "ass" | "vtt" };

// Blocks are read this far ahead of the playhead, and this far behind it so
// a line that began before a seek still shows. A block sits in the cluster
// its start falls in, and few lines last longer.
const lookAheadSeconds = 30;
const lookBehindSeconds = 10;
// A text block without a duration shows this long.
const fallbackSeconds = 4;

/** Converts SubRip to WebVTT: a header, and dots before the milliseconds. */
export function srtToVtt(srt: string): string {
  return `WEBVTT\n\n${srt
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(
      /(\d{2}:\d{2}:\d{2}),(\d{3}) --> (\d{2}:\d{2}:\d{2}),(\d{3})/g,
      "$1.$2 --> $3.$4",
    )}`;
}

/**
 * Shows WebVTT through a removable track element. Cues added before
 * `loaded` resolves are replaced by the parsed file, so add them after.
 */
function textTrack(video: HTMLVideoElement, vtt: string) {
  const element = document.createElement("track");
  const url = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
  element.kind = "subtitles";
  element.src = url;
  element.default = true;
  const loaded = new Promise<void>((resolve, reject) => {
    element.addEventListener("load", () => resolve(), { once: true });
    element.addEventListener(
      "error",
      () => reject(new Error("The subtitles did not load.")),
      { once: true },
    );
  });
  video.append(element);
  element.track.mode = "showing";
  return {
    track: element.track,
    loaded,
    close() {
      element.remove();
      URL.revokeObjectURL(url);
    },
  };
}

/** Draws ASS with libass through JASSUB, loaded only when a track needs it. */
async function assRenderer(
  video: HTMLVideoElement,
  header: string,
  fonts: Uint8Array[],
) {
  const { default: JASSUB } = await import("jassub");
  const renderer = new JASSUB({ video, subContent: header, fonts });
  await renderer.ready;
  return renderer;
}

/** Reads the blocks near the playhead as it moves, handing each to `show` once. */
function follow(
  video: HTMLVideoElement,
  read: (from: number, to: number) => Promise<SubtitleBlock[]>,
  show: (block: SubtitleBlock) => void,
  signal: AbortSignal,
) {
  let reading = false;
  let again = false;
  const pump = async () => {
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    try {
      do {
        again = false;
        const at = video.currentTime;
        const blocks = await read(
          at - lookBehindSeconds,
          at + lookAheadSeconds,
        );
        if (signal.aborted) return;
        for (const block of blocks) show(block);
      } while (again);
    } catch (error) {
      console.error(error);
    } finally {
      reading = false;
    }
  };
  for (const type of ["timeupdate", "seeking"])
    video.addEventListener(type, () => void pump(), { signal });
  void pump();
}

const decoder = new TextDecoder();
// SubRip in Matroska may carry ASS override tags such as {\an8}.
const overrides = /\{\\[^}]*\}/g;

/**
 * Shows a subtitle track over the video until closed: SubRip and WebVTT as
 * native text tracks, ASS through libass with the File's attached fonts.
 */
export async function showSubtitles(
  video: HTMLVideoElement,
  source: SubtitleSource,
): Promise<{ close(): void }> {
  if (source.kind === "file") {
    const text = await source.file.text();
    if (source.format === "ass") {
      const renderer = await assRenderer(video, text, []);
      return { close: () => void renderer.destroy() };
    }
    return textTrack(video, source.format === "srt" ? srtToVtt(text) : text);
  }
  const reader = await openMatroskaSubtitles(source.file);
  const track = reader?.tracks[source.position];
  if (reader === null || track === undefined)
    throw new Error("The download has no such subtitle track.");
  const stopped = new AbortController();
  const read = async (from: number, to: number) =>
    (await reader.read(from, to)).filter(
      (block) => block.track === track.number,
    );
  if (track.codecId === "S_TEXT/ASS" || track.codecId === "S_TEXT/SSA") {
    const header =
      track.codecPrivate === null ? "" : decoder.decode(track.codecPrivate);
    const renderer = await assRenderer(video, header, await reader.fonts());
    follow(
      video,
      read,
      (block) =>
        void renderer.renderer.processChunk(
          decoder.decode(block.data),
          block.start * 1000,
          ((block.end ?? block.start + fallbackSeconds) - block.start) * 1000,
        ),
      stopped.signal,
    );
    return {
      close() {
        stopped.abort();
        void renderer.destroy();
      },
    };
  }
  const shown = textTrack(video, "WEBVTT\n\n");
  await shown.loaded;
  follow(
    video,
    read,
    (block) =>
      shown.track.addCue(
        new VTTCue(
          block.start,
          block.end ?? block.start + fallbackSeconds,
          decoder.decode(block.data).replace(overrides, ""),
        ),
      ),
    stopped.signal,
  );
  return {
    close() {
      stopped.abort();
      shown.close();
    },
  };
}
