import type { DownloadStream } from "../downloads/index.ts";
import { audioType, videoType } from "../playback.ts";

/**
 * How a download plays here: the audio Stream to play, or why it can't, as a
 * caption-sized phrase such as `This browser can't play HEVC`.
 */
export type OfflinePlan =
  | { audioStreamIndex: number | null }
  | { reason: string };

const videoNames: Record<string, string> = {
  h264: "H.264",
  hevc: "HEVC",
  av1: "AV1",
  vp9: "VP9",
};

// Audio the browser can decode in software and re-encode while playing.
const convertible = (codec: string) =>
  codec === "ac3" ||
  codec === "eac3" ||
  codec === "dts" ||
  codec.startsWith("pcm_");

/** The player URL that plays a download from this browser, without the server. */
export function offlineHref(record: { itemId: string; versionId: string }) {
  return `/play/${record.itemId}?version=${record.versionId}&offline`;
}

/** Whether this page's Media Source plays an fMP4 MIME; false without one. */
export function browserDecodes(mime: string): boolean {
  const source: typeof MediaSource | undefined =
    globalThis.ManagedMediaSource ?? globalThis.MediaSource;
  return source?.isTypeSupported(mime) ?? false;
}

/**
 * Decides how a download plays from its probed Streams and what this
 * browser decodes: the asked audio Stream if it plays, else the first that
 * plays natively. Video is never converted.
 */
export function offlinePlan(
  streams: readonly DownloadStream[],
  codec: (mime: string) => boolean,
  audioStreamIndex?: number,
): OfflinePlan {
  const video = streams.find((stream) => stream.kind === "video");
  if (video === undefined) return { reason: "Has no video" };
  const videoMime = videoType(video.codec, video.profile);
  if (videoMime === null) return { reason: "Needs a server copy" };
  if (!codec(`video/mp4; codecs="${videoMime}"`)) {
    const name = videoNames[video.codec] ?? video.codec;
    return {
      reason:
        video.profile === "high10"
          ? `This browser can't play 10-bit ${name}`
          : `This browser can't play ${name}`,
    };
  }
  const audio = streams.filter((stream) => stream.kind === "audio");
  if (audio.length === 0) return { audioStreamIndex: null };
  const native = (stream: DownloadStream) => {
    const type = audioType(stream.codec);
    return type !== null && codec(`audio/mp4; codecs="${type}"`);
  };
  const asked = audio.find((stream) => stream.index === audioStreamIndex);
  const candidates = asked === undefined ? audio : [asked];
  const playing = candidates.find(native);
  if (playing !== undefined) return { audioStreamIndex: playing.index };
  return {
    reason: candidates.some((stream) => convertible(stream.codec))
      ? "Needs audio conversion"
      : "Needs a server copy",
  };
}
