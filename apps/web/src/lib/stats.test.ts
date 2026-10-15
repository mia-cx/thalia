import { describe, expect, test } from "bun:test";
import {
  codecName,
  filesystemSegments,
  formatCodecs,
  formatDynamicRange,
  formatResolution,
  libraryCaption,
  libraryCounts,
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

describe("library captions", () => {
  const kinds = { movies: 0, shows: 0, seasons: 0, episodes: 0 };
  const stats = (over: Partial<typeof kinds> = {}, bytes = 0) => ({
    kinds: { ...kinds, ...over },
    bytes,
  });

  test("the first line carries medium and folders only", () => {
    expect(libraryCaption({ medium: "movies", roots: [{}, {}] })).toBe(
      "Movies · 2 folders",
    );
    expect(libraryCaption({ medium: "shows", roots: [{}] })).toBe(
      "Shows · 1 folder",
    );
  });

  test("movies counts lead with the size", () => {
    expect(
      libraryCounts(
        { medium: "movies" },
        stats({ movies: 30 }, 266_000_000_000),
      ),
    ).toBe("266 GB · 30 movies");
    expect(libraryCounts({ medium: "movies" }, stats({ movies: 1 }))).toBe(
      "0 B · 1 movie",
    );
  });

  test("shows counts lead with the size and pluralise", () => {
    expect(
      libraryCounts(
        { medium: "shows" },
        stats({ shows: 1, episodes: 340 }, 1_200_000_000_000),
      ),
    ).toBe("1.2 TB · 1 show · 340 episodes");
    expect(
      libraryCounts({ medium: "shows" }, stats({ shows: 2, episodes: 1 })),
    ).toBe("0 B · 2 shows · 1 episode");
  });
});

describe("filesystemSegments", () => {
  const fs = {
    state: "available" as const,
    totalBytes: 1000,
    availableBytes: 300,
    usedBytes: 700,
    roots: [
      {
        id: "r1",
        libraryId: "a",
        libraryName: "Films",
        path: "/a",
        mediaBytes: 100,
      },
      {
        id: "r2",
        libraryId: "a",
        libraryName: "Films",
        path: "/b",
        mediaBytes: 50,
      },
      {
        id: "r3",
        libraryId: "b",
        libraryName: "TV",
        path: "/c",
        mediaBytes: 200,
      },
    ],
  };

  test("groups a library's roots into one segment and clamps Other at zero", () => {
    const { segments, otherBytes } = filesystemSegments(fs);
    expect(segments.map((s) => [s.label, s.bytes])).toEqual([
      ["Films", 150],
      ["TV", 200],
    ]);
    expect(otherBytes).toBe(350);
    expect(segments[0].tone).not.toBe(segments[1].tone);
  });

  test("Other clamps at zero when media exceeds used", () => {
    const { otherBytes } = filesystemSegments({
      ...fs,
      usedBytes: 100,
      availableBytes: 900,
    });
    expect(otherBytes).toBe(0);
  });

  test("a library filter keeps only its own segment", () => {
    const { segments, otherBytes } = filesystemSegments(fs, "b");
    expect(segments.map((s) => s.label)).toEqual(["TV"]);
    expect(otherBytes).toBe(500);
  });
});
