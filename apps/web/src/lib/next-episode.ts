import type { PlannedTracks, StreamChoice } from "./player.ts";

/** A Stream of the next Episode's Version, as the Item detail lists it. */
export type NextStream = {
  index: number;
  kind: "video" | "audio" | "subtitle";
  language: string | null;
  forced: boolean;
};

/**
 * Carries the playing audio and subtitle languages into a Stream choice for the
 * next Episode's Version; unknown or missing matches fall back to the server's
 * defaults by being absent.
 */
export function carryStreams(
  tracks: PlannedTracks | undefined,
  nextStreams: readonly NextStream[],
): StreamChoice {
  const choice: StreamChoice = {};
  const audioLanguage =
    tracks?.audioStreams.find(
      (stream) => stream.index === tracks.audioStreamIndex,
    )?.language ?? null;
  if (audioLanguage !== null) {
    const audio = nextStreams.find(
      (stream) => stream.kind === "audio" && stream.language === audioLanguage,
    );
    if (audio !== undefined) choice.audioStreamIndex = audio.index;
  }
  if (tracks === undefined || tracks.subtitleStreams.length === 0)
    return choice;
  const subtitleIndex = tracks.subtitleStreamIndex;
  // The viewer turned subtitles off; the next Episode keeps them off.
  if (subtitleIndex === null) {
    choice.subtitleStreamIndex = null;
    return choice;
  }
  const subtitleLanguage =
    tracks.subtitleStreams.find((stream) => stream.index === subtitleIndex)
      ?.language ?? null;
  if (subtitleLanguage === null) return choice;
  const subtitle = nextStreams.find(
    (stream) =>
      stream.kind === "subtitle" &&
      !stream.forced &&
      stream.language === subtitleLanguage,
  );
  if (subtitle !== undefined) choice.subtitleStreamIndex = subtitle.index;
  return choice;
}
