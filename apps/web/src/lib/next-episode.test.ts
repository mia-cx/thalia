import { describe, expect, test } from "bun:test";
import { carryStreams, type NextStream } from "./next-episode.ts";
import type { PlannedTracks } from "./player.ts";

const tracks = (part: Partial<PlannedTracks>): PlannedTracks =>
  ({
    audioStreams: [
      { index: 0, codec: "aac", channels: 2, language: "eng", title: null },
      { index: 1, codec: "aac", channels: 6, language: "jpn", title: null },
    ],
    subtitleStreams: [
      { index: 2, codec: "srt", language: "eng", title: null, forced: false },
      { index: 3, codec: "srt", language: "fra", title: null, forced: false },
    ],
    audioStreamIndex: 0,
    subtitleStreamIndex: null,
    creditsStartSeconds: null,
    quality: { original: null, rungs: [], storedVariantIds: [] },
    ...part,
  }) as PlannedTracks;

const nextStreams = (part: Partial<NextStream> = {}): NextStream[] => [
  { index: 0, kind: "video", language: null, forced: false, ...part },
];

describe("carryStreams", () => {
  test("carries the playing audio language to the first matching Stream", () => {
    const streams: NextStream[] = [
      { index: 0, kind: "video", language: null, forced: false },
      { index: 1, kind: "audio", language: "eng", forced: false },
      { index: 2, kind: "audio", language: "jpn", forced: false },
      { index: 3, kind: "audio", language: "jpn", forced: false },
    ];
    expect(carryStreams(tracks({ audioStreamIndex: 1 }), streams)).toEqual({
      audioStreamIndex: 2,
      subtitleStreamIndex: null,
    });
  });

  test("omits audio with no tracks, an unknown language or no match", () => {
    const streams = nextStreams();
    expect(carryStreams(undefined, streams)).toEqual({});
    expect(carryStreams(tracks({ audioStreamIndex: null }), streams)).toEqual({
      subtitleStreamIndex: null,
    });
    expect(
      carryStreams(
        tracks({
          audioStreamIndex: 1,
          audioStreams: [
            {
              index: 1,
              codec: "aac",
              channels: 2,
              language: null,
              title: null,
            },
          ],
        }),
        streams,
      ),
    ).toEqual({ subtitleStreamIndex: null });
  });

  test("carries subtitles-off when the Version had subtitle Streams", () => {
    expect(
      carryStreams(tracks({ subtitleStreamIndex: null }), nextStreams()),
    ).toEqual({ subtitleStreamIndex: null });
  });

  test("carries the subtitle language to the first non-forced match", () => {
    const streams: NextStream[] = [
      { index: 0, kind: "subtitle", language: "fra", forced: true },
      { index: 1, kind: "subtitle", language: "fra", forced: false },
    ];
    expect(carryStreams(tracks({ subtitleStreamIndex: 3 }), streams)).toEqual({
      subtitleStreamIndex: 1,
    });
  });

  test("omits subtitles with no match, and entirely when none existed", () => {
    expect(
      carryStreams(tracks({ subtitleStreamIndex: 3 }), [
        { index: 0, kind: "subtitle", language: "eng", forced: false },
      ]),
    ).toEqual({});
    expect(
      carryStreams(
        tracks({ subtitleStreamIndex: null, subtitleStreams: [] }),
        nextStreams(),
      ),
    ).toEqual({});
  });
});
