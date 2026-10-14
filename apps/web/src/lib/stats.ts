import type { ThaliaClient } from "./api.ts";

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
