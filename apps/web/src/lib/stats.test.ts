import { describe, expect, test } from "bun:test";
import {
  codecName,
  formatCodecs,
  formatDynamicRange,
  formatResolution,
  replaceLibraryEntry,
} from "./stats.ts";

describe("stats formatting", () => {
  test("codecName maps known codecs and uppercases the rest", () => {
    expect(codecName("h264")).toBe("H.264");
    expect(codecName("hevc")).toBe("HEVC");
    expect(codecName("av1")).toBe("AV1");
    expect(codecName("vp9")).toBe("VP9");
    expect(codecName("mpeg2video")).toBe("MPEG-2");
    expect(codecName("av01")).toBe("AV01");
  });

  test("formatResolution lists non-zero buckets best first", () => {
    expect(
      formatResolution({ uhd: 239, fullHd: 219, hd: 4, lower: 3, unknown: 1 }),
    ).toBe("4K 239 · 1080p 219 · 720p 4 · Lower 3 · Unknown 1");
    expect(
      formatResolution({ uhd: 0, fullHd: 10, hd: 0, lower: 0, unknown: 0 }),
    ).toBe("1080p 10");
    expect(
      formatResolution({ uhd: 0, fullHd: 0, hd: 0, lower: 0, unknown: 0 }),
    ).toBe("None");
  });

  test("formatDynamicRange lists non-zero buckets best first", () => {
    expect(formatDynamicRange({ dolbyVision: 12, hdr: 40, sdr: 400 })).toBe(
      "Dolby Vision 12 · HDR 40 · SDR 400",
    );
    expect(formatDynamicRange({ dolbyVision: 0, hdr: 0, sdr: 2 })).toBe(
      "SDR 2",
    );
    expect(formatDynamicRange({ dolbyVision: 0, hdr: 0, sdr: 0 })).toBe("None");
  });

  test("formatCodecs keeps the API order with display names", () => {
    expect(
      formatCodecs([
        { codec: "hevc", versions: 300 },
        { codec: "h264", versions: 161 },
      ]),
    ).toBe("HEVC 300 · H.264 161");
    expect(formatCodecs([])).toBe("None");
  });

  test("replaceLibraryEntry swaps the matching row and appends unknown ids", () => {
    const list = [
      { libraryId: "a", items: 1 },
      { libraryId: "b", items: 2 },
    ];
    expect(replaceLibraryEntry(list, { libraryId: "b", items: 9 })).toEqual([
      { libraryId: "a", items: 1 },
      { libraryId: "b", items: 9 },
    ]);
    expect(replaceLibraryEntry(list, { libraryId: "c", items: 3 })).toEqual([
      ...list,
      { libraryId: "c", items: 3 },
    ]);
  });
});
