import { describe, expect, test } from "bun:test";
import type { ItemDetail } from "../browse.ts";
import { downloadedDetail, groupDownloads } from "./library.ts";
import type { DownloadRecord } from "./store.ts";
import { itemDetail } from "./testing.ts";

function record(
  detail: ItemDetail | null,
  versionId: string,
  state: DownloadRecord["state"] = "complete",
): DownloadRecord {
  return {
    itemId: detail?.id ?? versionId,
    versionId,
    title: detail?.title ?? "Old download",
    bytes: 10,
    container: "matroska",
    streams: [],
    written: state === "complete" ? 10 : 4,
    state,
    etag: null,
    subtitles: [],
    detail,
    fileName: null,
  };
}

const severance = { id: "show-s", title: "Severance" };
const andor = { id: "show-a", title: "Andor" };

function episode(
  show: { id: string; title: string },
  seasonNumber: number,
  episodeNumber: number,
  title: string,
) {
  return itemDetail({
    id: `${show.id}-${seasonNumber}-${episodeNumber}`,
    kind: "episode",
    title,
    parentId: `${show.id}-season-${seasonNumber}`,
    seasonNumber,
    episodeNumber,
    show: {
      ...show,
      posterArtworkId: `${show.id}-poster`,
      backdropArtworkId: null,
      logoArtworkId: null,
    },
  });
}

describe("groupDownloads", () => {
  test("lists Movies by title, then Shows by title with Seasons and Episodes in order, Specials last", () => {
    const groups = groupDownloads([
      record(episode(severance, 2, 1, "Hello, Ms. Cobel"), "v1"),
      record(itemDetail({ id: "m-z", title: "Zodiac" }), "v2"),
      record(episode(severance, 0, 1, "Inside Lumon"), "v3"),
      record(episode(severance, 1, 3, "In Perpetuity"), "v4"),
      record(null, "v5"),
      record(episode(andor, 1, 1, "Kassa"), "v6", "paused"),
      record(episode(severance, 1, 1, "Good News About Hell"), "v7"),
      record(itemDetail({ id: "m-a", title: "Arrival" }), "v8"),
    ]);

    expect(groups.movies.map((movie) => movie.detail.title)).toEqual([
      "Arrival",
      "Zodiac",
    ]);
    expect(
      groups.shows.map((show) => ({
        title: show.title,
        poster: show.posterArtworkId,
        seasons: show.seasons.map((season) => ({
          season: season.seasonNumber,
          episodes: season.episodes.map((entry) => entry.detail.title),
        })),
      })),
    ).toEqual([
      {
        title: "Andor",
        poster: "show-a-poster",
        seasons: [{ season: 1, episodes: ["Kassa"] }],
      },
      {
        title: "Severance",
        poster: "show-s-poster",
        seasons: [
          {
            season: 1,
            episodes: ["Good News About Hell", "In Perpetuity"],
          },
          { season: 2, episodes: ["Hello, Ms. Cobel"] },
          { season: 0, episodes: ["Inside Lumon"] },
        ],
      },
    ]);
    expect(groups.other.map((entry) => entry.versionId)).toEqual(["v5"]);
  });
});

describe("downloadedDetail", () => {
  const movie = itemDetail({
    id: "m-a",
    versions: ["kept", "other"].map((id) => ({
      id,
      libraryId: "library",
      label: id,
      format: "video" as const,
      durationSeconds: 60,
      bytes: 10,
      playable: true,
      container: "matroska",
      streams: [],
    })),
  });

  test("opens a finished download with only its downloaded Version", () => {
    const detail = downloadedDetail([record(movie, "kept")], "m-a");
    expect(detail?.title).toBe("Arrival");
    expect(detail?.versions.map((version) => version.id)).toEqual(["kept"]);
  });

  test("has nothing for an unfinished download or another Item", () => {
    expect(
      downloadedDetail([record(movie, "kept", "paused")], "m-a"),
    ).toBeUndefined();
    expect(downloadedDetail([record(movie, "kept")], "m-b")).toBeUndefined();
  });
});
