import type { ThaliaClient } from "./api.ts";
import { formatBytes } from "./browse.ts";

/** One library's dashboard numbers, as `libraries.stats` returns them. */
export type LibraryStats = Awaited<
  ReturnType<ThaliaClient["libraries"]["stats"]>
>[number];

/** One library's metadata gap counts, as `libraries.metadataGaps` returns them. */
export type LibraryGaps = Awaited<
  ReturnType<ThaliaClient["libraries"]["metadataGaps"]>
>[number];

/** A filesystem's free space, as `libraries.freeSpace` returns it. */
export type FilesystemSpace = Awaited<
  ReturnType<ThaliaClient["libraries"]["freeSpace"]>
>[number];

/** An item a gap list returns. */
export type MetadataGapItem = Awaited<
  ReturnType<ThaliaClient["libraries"]["metadataGapItems"]>
>["items"][number];

/** The gap names, derived from the counts row so they can't drift. */
export type MetadataGap = Exclude<keyof LibraryGaps, "libraryId">;

const numberFormat = new Intl.NumberFormat();

/** A count in the viewer's locale, such as `1,234`. */
export function formatCount(count: number): string {
  return numberFormat.format(count);
}

const codecNames: Record<string, string> = {
  h264: "H.264",
  hevc: "HEVC",
  av1: "AV1",
  vp9: "VP9",
  mpeg2video: "MPEG-2",
};

/** A codec's display name, such as `H.264`; unknown codecs uppercase. */
export function codecName(codec: string): string {
  return codecNames[codec] ?? codec.toUpperCase();
}

/** Counts joined as `Label n`, skipping zeros, or "None" for an empty mix. */
function mix(parts: readonly (readonly [string, number])[]): string {
  const shown = parts
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${label} ${numberFormat.format(count)}`);
  return shown.length === 0 ? "None" : shown.join(" · ");
}

/** The resolution mix, such as `4K 239 · 1080p 219 · 720p 4`. */
export function formatResolution(resolution: LibraryStats["resolution"]) {
  return mix([
    ["4K", resolution.uhd],
    ["1080p", resolution.fullHd],
    ["720p", resolution.hd],
    ["Lower", resolution.lower],
    ["Unknown", resolution.unknown],
  ]);
}

/** The dynamic-range mix, such as `Dolby Vision 12 · HDR 40 · SDR 400`. */
export function formatDynamicRange(range: LibraryStats["dynamicRange"]) {
  return mix([
    ["Dolby Vision", range.dolbyVision],
    ["HDR", range.hdr],
    ["SDR", range.sdr],
  ]);
}

/** The codec mix, such as `HEVC 300 · H.264 161`. */
export function formatCodecs(codecs: LibraryStats["codecs"]) {
  const shown = codecs.map(
    ({ codec, versions }) =>
      `${codecName(codec)} ${numberFormat.format(versions)}`,
  );
  return shown.length === 0 ? "None" : shown.join(" · ");
}

/** The list with one library's entry replaced; unknown ids append at the end. */
export function replaceLibraryEntry<T extends { libraryId: string }>(
  list: readonly T[],
  entry: T,
): T[] {
  const index = list.findIndex((row) => row.libraryId === entry.libraryId);
  if (index === -1) return [...list, entry];
  return list.with(index, entry);
}

/** The server-wide media totals, as `libraries.summary` returns them. */
export type LibrarySummary = Awaited<
  ReturnType<ThaliaClient["libraries"]["summary"]>
>;

/** One noun, pluralised for a caption: `1 movie`, `2 episodes`. */
export function pluralize(count: number, noun: string): string {
  return `${numberFormat.format(count)} ${count === 1 ? noun : `${noun}s`}`;
}

/** A library row's first caption line: `Shows · 2 folders`. */
export function libraryCaption(library: {
  medium: "movies" | "shows";
  roots: readonly unknown[];
}): string {
  return [
    library.medium === "movies" ? "Movies" : "Shows",
    pluralize(library.roots.length, "folder"),
  ].join(" · ");
}

/** The second caption line once stats load: `1.2 TB · 12 shows · 340 episodes` — size first so truncation drops counts, not the size. */
export function libraryCounts(
  library: { medium: "movies" | "shows" },
  stats: Pick<LibraryStats, "kinds" | "bytes">,
): string {
  const parts = [formatBytes(stats.bytes)];
  if (library.medium === "shows")
    parts.push(
      pluralize(stats.kinds.shows, "show"),
      pluralize(stats.kinds.episodes, "episode"),
    );
  else parts.push(pluralize(stats.kinds.movies, "movie"));
  return parts.join(" · ");
}

type AvailableSpace = Extract<FilesystemSpace, { state: "available" }>;

/** One colored slice of a filesystem's usage bar. */
export type SpaceSegment = {
  key: string;
  label: string;
  bytes: number;
  tone: string;
};

/**
 * A distinct tint per library, built from design tokens so light and dark
 * themes both work; `other` is the neutral fill for non-media usage.
 */
export const segmentTones = [
  "var(--tint)",
  "color-mix(in oklch, var(--tint) 65%, var(--background))",
  "color-mix(in oklch, var(--tint) 42%, var(--background))",
  "color-mix(in oklch, var(--tint) 25%, var(--background))",
];
export const otherTone = "var(--fill-strong)";

/**
 * The slices of one filesystem's bar: one segment per library holding media
 * there (or only `libraryId`'s, when given), then Other for used space no
 * tracked File explains, clamped at zero.
 */
export function filesystemSegments(
  filesystem: AvailableSpace,
  libraryId?: string,
): { segments: SpaceSegment[]; otherBytes: number } {
  const byLibrary = new Map<string, { label: string; bytes: number }>();
  for (const root of filesystem.roots) {
    if (libraryId !== undefined && root.libraryId !== libraryId) continue;
    const entry = byLibrary.get(root.libraryId) ?? {
      label: root.libraryName,
      bytes: 0,
    };
    entry.bytes += root.mediaBytes;
    byLibrary.set(root.libraryId, entry);
  }
  const segments = [...byLibrary.entries()].map(
    ([id, entry], i): SpaceSegment => ({
      key: id,
      label: entry.label,
      bytes: entry.bytes,
      tone: segmentTones[i % segmentTones.length],
    }),
  );
  const media = segments.reduce((sum, segment) => sum + segment.bytes, 0);
  return {
    segments,
    otherBytes: Math.max(0, filesystem.usedBytes - media),
  };
}
