import type { ItemDetail } from "../browse.ts";
import type { DownloadRecord } from "./store.ts";

/** A downloaded record together with the Item it saved. */
export type DownloadedItem = DownloadRecord & { detail: ItemDetail };

/** One Show on the Downloads page: its Seasons in order, each with its downloaded Episodes in order. */
export type DownloadedShow = {
  id: string;
  title: string;
  posterArtworkId: string | null;
  seasons: {
    id: string;
    seasonNumber: number | null;
    episodes: DownloadedItem[];
  }[];
};

const byTitle = (a: { title: string }, b: { title: string }) =>
  a.title.localeCompare(b.title);

/** Orders numbers ascending with nulls last; `last` also sorts after every other number. */
const byNumber = (last?: number) => (a: number | null, b: number | null) => {
  const rank = (n: number | null) => (n === null ? 2 : n === last ? 1 : 0);
  return rank(a) - rank(b) || (a ?? 0) - (b ?? 0);
};
const bySeason = byNumber(0);
const byEpisode = byNumber();

/**
 * Groups downloads as the Downloads page lists them, from what each saved at
 * download time: Movies by title, then Shows by title with their Seasons in
 * order (Specials last) and Episodes in order. Records saved before details
 * were kept come last, ungrouped.
 */
export function groupDownloads(records: readonly DownloadRecord[]): {
  movies: DownloadedItem[];
  shows: DownloadedShow[];
  other: DownloadRecord[];
} {
  const movies: DownloadedItem[] = [];
  const shows = new Map<string, DownloadedShow>();
  const other: DownloadRecord[] = [];
  for (const record of records) {
    const { detail } = record;
    if (detail === null) {
      other.push(record);
    } else if (detail.kind === "episode" && detail.show !== null) {
      const show = shows.get(detail.show.id) ?? {
        id: detail.show.id,
        title: detail.show.title,
        posterArtworkId: detail.show.posterArtworkId,
        seasons: [],
      };
      shows.set(show.id, show);
      const seasonId = detail.parentId ?? `${detail.seasonNumber}`;
      let season = show.seasons.find((entry) => entry.id === seasonId);
      if (season === undefined) {
        season = {
          id: seasonId,
          seasonNumber: detail.seasonNumber,
          episodes: [],
        };
        show.seasons.push(season);
      }
      season.episodes.push({ ...record, detail });
    } else {
      movies.push({ ...record, detail });
    }
  }
  for (const show of shows.values()) {
    show.seasons.sort((a, b) => bySeason(a.seasonNumber, b.seasonNumber));
    for (const season of show.seasons)
      season.episodes.sort(
        (a, b) =>
          byEpisode(a.detail.episodeNumber, b.detail.episodeNumber) ||
          byTitle(a.detail, b.detail),
      );
  }
  return {
    movies: movies.sort((a, b) => byTitle(a.detail, b.detail)),
    shows: [...shows.values()].sort(byTitle),
    other,
  };
}

/**
 * The saved detail of a finished download of `itemId`, for its page to show
 * without the server. It lists only the downloaded Version, the one that
 * plays offline.
 */
export function downloadedDetail(
  records: readonly DownloadRecord[],
  itemId: string,
): ItemDetail | undefined {
  const record = records.find(
    (entry) => entry.state === "complete" && entry.detail?.id === itemId,
  );
  if (record?.detail === null || record?.detail === undefined) return undefined;
  const { detail, versionId } = record;
  return {
    ...detail,
    versions: detail.versions.filter((version) => version.id === versionId),
  };
}
