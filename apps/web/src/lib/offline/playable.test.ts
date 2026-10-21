import { describe, expect, test } from "bun:test";
import type { DownloadStream } from "../downloads/index.ts";
import { offlinePlan } from "./playable.ts";

const stream = (
  index: number,
  kind: DownloadStream["kind"],
  codec: string,
  profile: string | null = null,
): DownloadStream => ({
  index,
  kind,
  codec,
  profile,
  language: null,
  title: null,
  channels: kind === "audio" ? 2 : null,
  width: kind === "video" ? 1920 : null,
  height: kind === "video" ? 1080 : null,
  hdr: kind === "video" ? "sdr" : null,
  default: false,
  forced: false,
});

// What Chrome on Linux without an HEVC decoder answers.
const chrome = (mime: string) =>
  ["avc1.640028", "av01.0.08M.08", "mp4a.40.2", "opus", "flac", "mp4a.6B"].some(
    (type) => mime.includes(`"${type}"`),
  );

describe("offline plan", () => {
  test.each([
    {
      why: "H.264 with AAC plays as is",
      streams: [stream(0, "video", "h264", "high"), stream(1, "audio", "aac")],
      expected: { audioStreamIndex: 1 },
    },
    {
      why: "the first audio Stream that plays wins over an earlier one that doesn't",
      streams: [
        stream(0, "video", "h264", "high"),
        stream(1, "audio", "ac3"),
        stream(2, "audio", "aac"),
      ],
      expected: { audioStreamIndex: 2 },
    },
    {
      why: "no audio plays the video alone",
      streams: [stream(0, "video", "av1", "main")],
      expected: { audioStreamIndex: null },
    },
    {
      why: "a codec the browser lacks is named",
      streams: [
        stream(0, "video", "hevc", "main10"),
        stream(1, "audio", "aac"),
      ],
      expected: { reason: "This browser can't play HEVC" },
    },
    {
      why: "Dolby audio alone needs converting",
      streams: [stream(0, "video", "h264", "high"), stream(1, "audio", "eac3")],
      expected: { reason: "Needs audio conversion" },
    },
    {
      why: "TrueHD alone has no decoder in any browser",
      streams: [
        stream(0, "video", "h264", "high"),
        stream(1, "audio", "truehd"),
      ],
      expected: { reason: "Needs a server copy" },
    },
    {
      why: "VC-1 has no decoder in any browser",
      streams: [stream(0, "video", "vc1"), stream(1, "audio", "aac")],
      expected: { reason: "Needs a server copy" },
    },
  ])("$why", ({ streams, expected }) => {
    expect(offlinePlan(streams, chrome)).toEqual(expected);
  });

  test("an asked audio Stream plays when it can and is refused when it can't", () => {
    const streams = [
      stream(0, "video", "h264", "high"),
      stream(1, "audio", "aac"),
      stream(2, "audio", "opus"),
      stream(3, "audio", "dts"),
    ];
    expect(offlinePlan(streams, chrome, 2)).toEqual({ audioStreamIndex: 2 });
    expect(offlinePlan(streams, chrome, 3)).toEqual({
      reason: "Needs audio conversion",
    });
  });
});
