import type { DownloadStream } from "../downloads/index.ts";
import { audioType, videoType } from "../playback.ts";

/**
 * How a download plays here: the audio Stream to play and whether it is
 * converted while playing, or why it can't play, as a caption-sized phrase
 * such as `This browser can't play HEVC`.
 */
export type OfflinePlan =
  | { audioStreamIndex: number | null; convert: boolean }
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

/** What converted audio is encoded as. */
export type Conversion = {
  codec: "aac" | "opus";
  /** The fMP4 codec string. */
  type: string;
  numberOfChannels: number;
  sampleRate: number;
};

/**
 * Picks what to encode converted audio as: AAC, else Opus, whichever the
 * Media Source plays and an encoder takes, keeping the source's channels
 * and downmixing to stereo only when no encoder takes them. Null when
 * nothing fits.
 */
export async function pickConversion(
  source: { numberOfChannels: number; sampleRate: number },
  decodes: (mime: string) => boolean,
  encodes: (
    codec: Conversion["codec"],
    options: { numberOfChannels: number; sampleRate: number },
  ) => Promise<boolean>,
): Promise<Conversion | null> {
  const codecs = (
    [
      ["aac", "mp4a.40.2"],
      ["opus", "opus"],
    ] as const
  ).filter(([, type]) => decodes(`audio/mp4; codecs="${type}"`));
  for (const numberOfChannels of new Set([source.numberOfChannels, 2]))
    for (const [codec, type] of codecs) {
      // Opus encodes at 48 kHz only.
      const sampleRate = codec === "opus" ? 48_000 : source.sampleRate;
      if (await encodes(codec, { numberOfChannels, sampleRate }))
        return { codec, type, numberOfChannels, sampleRate };
    }
  return null;
}

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
 * plays natively, else the first Dolby, DTS or PCM Stream, converted. Video
 * is never converted.
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
  if (audio.length === 0) return { audioStreamIndex: null, convert: false };
  const native = (stream: DownloadStream) => {
    const type = audioType(stream.codec);
    return type !== null && codec(`audio/mp4; codecs="${type}"`);
  };
  const asked = audio.find((stream) => stream.index === audioStreamIndex);
  const candidates = asked === undefined ? audio : [asked];
  const playing = candidates.find(native);
  if (playing !== undefined)
    return { audioStreamIndex: playing.index, convert: false };
  // Converted audio is encoded as AAC or Opus, so the browser must play one.
  const encodable =
    codec(`audio/mp4; codecs="mp4a.40.2"`) || codec(`audio/mp4; codecs="opus"`);
  const converted = candidates.find((stream) => convertible(stream.codec));
  if (converted !== undefined && encodable)
    return { audioStreamIndex: converted.index, convert: true };
  return { reason: "Needs a server copy" };
}
