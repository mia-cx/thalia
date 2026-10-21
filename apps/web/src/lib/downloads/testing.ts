import type { ItemDetail } from "../browse.ts";

/** An Item detail as the server sends it, for download tests; `overrides` sets what the test reads. */
export function itemDetail(overrides: Partial<ItemDetail> = {}): ItemDetail {
  return {
    id: "01900000-0000-7000-8000-000000000001",
    kind: "movie",
    homeLibraryId: null,
    title: "Arrival",
    year: 2016,
    addedAt: "2026-10-01T00:00:00.000Z",
    posterArtworkId: null,
    backdropArtworkId: null,
    logoArtworkId: null,
    thumbArtworkId: null,
    parentId: null,
    seasonNumber: null,
    episodeNumber: null,
    episodeEndNumber: null,
    show: null,
    overview: null,
    contentRating: null,
    genres: [],
    tags: [],
    metadataState: "matched",
    updatedAt: "2026-10-01T00:00:00.000Z",
    credits: [],
    canDownload: true,
    versions: [],
    subtitles: [],
    children: [],
    ...overrides,
  };
}
