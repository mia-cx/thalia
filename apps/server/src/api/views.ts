import { resolve } from "node:path";
import {
  and,
  arrayOverlaps,
  asc,
  count,
  eq,
  inArray,
  isNull,
  notInArray,
  type SQL,
  sql,
} from "drizzle-orm";
import { alias, type PgSelect } from "drizzle-orm/pg-core";
import {
  checkPermission,
  permittedVersionIds,
  viewableLibraryIds,
} from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import {
  artwork,
  contributors,
  credits,
  episodes,
  favourites,
  files,
  itemAncestors,
  items,
  libraries,
  libraryRoots,
  movies,
  progress,
  providerIds,
  ratings,
  seasons,
  shows,
  streams,
  versions,
} from "../db/schema/index.ts";
import { homeLibraryId, inLibraries } from "../libraries/membership.ts";
import { listSubtitles, type StoredSubtitle } from "../subtitles/store.ts";

type ItemKind = (typeof items.kind.enumValues)[number];

/** The orders an Item view list can take. `number` walks seasons, then episodes. */
export type ItemViewSort =
  | "title"
  | "added"
  | "premiere"
  | "year"
  | "number"
  | "played";

/** Which Items to list and how. Every filter narrows the libraries the caller may view. */
export type ItemViewQuery = {
  readonly libraryIds?: readonly string[];
  /** Direct children of an Item; null lists the library roots. */
  readonly parentId?: string | null;
  /** Every descendant of an Item, at any depth. */
  readonly ancestorId?: string;
  readonly kinds?: readonly ItemKind[];
  readonly ids?: readonly string[];
  readonly search?: string;
  readonly genres?: readonly string[];
  readonly tags?: readonly string[];
  readonly years?: readonly number[];
  readonly contributorIds?: readonly string[];
  readonly contributorRoles?: readonly string[];
  readonly excludeIds?: readonly string[];
  readonly premiereBefore?: string;
  readonly premiereAfter?: string;
  readonly seasonNumber?: number;
  readonly indexNumber?: number;
  readonly contentRatings?: readonly string[];
  readonly hasOverview?: boolean;
  readonly hasContentRating?: boolean;
  readonly providerPresence?: Readonly<Record<string, boolean>>;
  readonly audioLanguages?: readonly string[];
  readonly subtitleLanguages?: readonly string[];
  readonly nameStartsWithOrGreater?: string;
  /** Titles starting with this text, ignoring case. */
  readonly nameStartsWith?: string;
  /** Titles that sort before this text, ignoring case. */
  readonly nameLessThan?: string;
  readonly favourite?: boolean;
  readonly played?: boolean;
  readonly resumable?: boolean;
  readonly sort?: readonly {
    readonly by: ItemViewSort;
    readonly descending?: boolean;
  }[];
  readonly offset?: number;
  readonly limit?: number;
};

const ownSeason = alias(seasons, "own_season");
const episodeSeason = alias(seasons, "episode_season");
const showItem = alias(items, "show_item");

// Columns are named in full: inside a subquery an unqualified id binds to the inner table.
const selectedArtwork = (owner: "items" | "show_item", type: string) =>
  sql<string | null>`(
    select ${artwork.id} from ${artwork}
    where ${artwork.itemId} = ${sql.identifier(owner)}."id"
      and ${artwork.type} = ${type} and ${artwork.selected}
    limit 1
  )`;

const premiereDate = sql<
  string | null
>`coalesce(${movies.releaseDate}, ${shows.firstAirDate}, ${ownSeason.airDate}, ${episodes.airDate})::text`;
const seasonNumber = sql<
  number | null
>`coalesce(${ownSeason.seasonNumber}, ${episodeSeason.seasonNumber})`;

function streamLanguages(
  kind: "audio" | "subtitle",
  languages: readonly string[] | undefined,
) {
  if (languages === undefined) return undefined;
  return sql`exists (select 1 from ${streams}
    inner join ${versions} on ${versions.id} = ${streams.versionId}
    where ${versions.itemId} = ${items.id} and ${streams.kind} = ${kind}
      and ${inArray(streams.language, [...languages])})`;
}

const viewFields = {
  id: items.id,
  kind: items.kind,
  libraryId: sql<string>`${homeLibraryId()}`.as("library_id"),
  parentId: items.parentId,
  title: items.title,
  year: items.year,
  overview: items.overview,
  contentRating: items.contentRating,
  genres: items.genres,
  tags: items.tags,
  addedAt: items.addedAt,
  premiereDate: premiereDate.as("premiere_date"),
  endDate: sql<string | null>`${shows.lastAirDate}::text`.as("end_date"),
  status: shows.status,
  seasonNumber: seasonNumber.as("season_number"),
  episodeNumber: episodes.episodeNumber,
  episodeEndNumber: episodes.episodeEndNumber,
  seasonId: episodes.seasonId,
  showId: sql<string | null>`${showItem.id}`.as("show_id"),
  showTitle: sql<string | null>`${showItem.title}`.as("show_title"),
  showPoster: selectedArtwork("show_item", "poster").as("showPoster"),
  showBackdrop: selectedArtwork("show_item", "backdrop").as("showBackdrop"),
  poster: selectedArtwork("items", "poster").as("poster"),
  backdrop: selectedArtwork("items", "backdrop").as("backdrop"),
  logo: selectedArtwork("items", "logo").as("logo"),
  thumb: selectedArtwork("items", "thumb").as("thumb"),
  // The first imported Version in label order, as the detail screen lists them.
  durationSeconds: sql<number | null>`(
    select ${versions.durationSeconds} from ${versions}
    where ${versions.itemId} = ${items.id} and ${versions.origin} = 'imported'
    order by ${versions.label}, ${versions.id}
    limit 1
  )`.as("duration_seconds"),
  childCount: sql<number>`(
    select count(*)::int from ${items} as child where child.parent_id = ${items.id}
  )`.as("child_count"),
  providerIds: sql<Record<string, string>>`(
    select coalesce(jsonb_object_agg(${providerIds.provider}, ${providerIds.value}), '{}'::jsonb)
    from ${providerIds} where ${providerIds.itemId} = ${items.id}
  )`.as("provider_ids"),
  positionSeconds: progress.positionSeconds,
  completed: progress.completed,
  playCount: progress.playCount,
  playedAt: progress.playedAt,
  favourite: sql<boolean>`${favourites.id} is not null`.as("favourite"),
  rating: ratings.value,
  liked: ratings.liked,
};

const sortColumns: Record<ItemViewSort, SQL[]> = {
  title: [sql`${items.title}`],
  added: [sql`${items.addedAt}`],
  premiere: [premiereDate],
  year: [sql`${items.year}`],
  number: [seasonNumber, sql`${episodes.episodeNumber}`],
  played: [sql`${progress.playedAt}`],
};

function orderOf(sort: ItemViewQuery["sort"]): SQL[] {
  const keys = sort?.length
    ? sort
    : [{ by: "number" as const }, { by: "title" as const }];
  return [
    ...keys.flatMap(({ by, descending }) =>
      sortColumns[by].map((column) =>
        descending
          ? sql`${column} desc nulls last`
          : sql`${column} asc nulls last`,
      ),
    ),
    asc(items.id),
  ];
}

function filtersOf(viewable: string[], query: ItemViewQuery) {
  const requested = query.libraryIds;
  const scope =
    requested === undefined
      ? viewable
      : viewable.filter((id) => requested.includes(id));
  const { parentId, ancestorId, kinds, ids, search } = query;
  return and(
    inLibraries(scope),
    parentId === undefined
      ? undefined
      : parentId === null
        ? isNull(items.parentId)
        : eq(items.parentId, parentId),
    ancestorId === undefined
      ? undefined
      : sql`exists (
          select 1 from ${itemAncestors}
          where ${itemAncestors.ancestorId} = ${ancestorId}
            and ${itemAncestors.descendantId} = ${items.id}
            and ${itemAncestors.depth} > 0
        )`,
    kinds === undefined ? undefined : inArray(items.kind, [...kinds]),
    ids === undefined ? undefined : inArray(items.id, [...ids]),
    query.excludeIds?.length
      ? notInArray(items.id, [...query.excludeIds])
      : undefined,
    query.genres === undefined
      ? undefined
      : query.genres.length
        ? arrayOverlaps(items.genres, [...query.genres])
        : sql`false`,
    query.tags === undefined
      ? undefined
      : query.tags.length
        ? arrayOverlaps(items.tags, [...query.tags])
        : sql`false`,
    query.years === undefined
      ? undefined
      : inArray(items.year, [...query.years]),
    query.contributorIds === undefined
      ? undefined
      : sql`exists (select 1 from ${credits} where ${credits.itemId} = ${items.id} and ${inArray(credits.contributorId, [...query.contributorIds])} ${query.contributorRoles?.length ? sql`and ${inArray(sql`lower(regexp_replace(${credits.role}, '[^a-zA-Z]', '', 'g'))`, [...query.contributorRoles])}` : sql``})`,
    query.premiereBefore === undefined
      ? undefined
      : sql`${premiereDate} <= ${query.premiereBefore}`,
    query.premiereAfter === undefined
      ? undefined
      : sql`${premiereDate} >= ${query.premiereAfter}`,
    query.seasonNumber === undefined
      ? undefined
      : sql`${seasonNumber} = ${query.seasonNumber}`,
    query.indexNumber === undefined
      ? undefined
      : sql`coalesce(${ownSeason.seasonNumber}, ${episodes.episodeNumber}) = ${query.indexNumber}`,
    query.contentRatings === undefined
      ? undefined
      : inArray(items.contentRating, [...query.contentRatings]),
    query.hasOverview === undefined
      ? undefined
      : sql`(coalesce(length(trim(${items.overview})), 0) > 0) = ${query.hasOverview}`,
    query.hasContentRating === undefined
      ? undefined
      : sql`(${items.contentRating} is not null) = ${query.hasContentRating}`,
    ...Object.entries(query.providerPresence ?? {}).map(
      ([provider, present]) =>
        sql`exists (select 1 from ${providerIds} where ${providerIds.itemId} = ${items.id} and ${providerIds.provider} = ${provider}) = ${present}`,
    ),
    streamLanguages("audio", query.audioLanguages),
    streamLanguages("subtitle", query.subtitleLanguages),
    search === undefined
      ? undefined
      : sql`(${items.title} % ${search} or ${search} <% ${items.title})`,
    query.nameStartsWith === undefined
      ? undefined
      : sql`starts_with(lower(${items.title}), lower(${query.nameStartsWith}))`,
    // Byte order, so "#" in a letter picker means digits and symbols before "a".
    query.nameLessThan === undefined
      ? undefined
      : sql`lower(${items.title}) collate "C" < lower(${query.nameLessThan}) collate "C"`,
    query.nameStartsWithOrGreater === undefined
      ? undefined
      : sql`lower(${items.title}) collate "C" >= lower(${query.nameStartsWithOrGreater}) collate "C"`,
    query.favourite === undefined
      ? undefined
      : sql`(${favourites.id} is not null) = ${query.favourite}`,
    query.played === undefined
      ? undefined
      : sql`coalesce(${progress.completed}, false) = ${query.played}`,
    query.resumable === undefined
      ? undefined
      : sql`(coalesce(not ${progress.completed} and ${progress.positionSeconds} > 0, false)) = ${query.resumable}`,
  );
}

// Every join adds at most one row per Item, so a count over the same joins stays exact.
function withJoins<T extends PgSelect>(query: T, userId: string) {
  return query
    .leftJoin(movies, eq(movies.itemId, items.id))
    .leftJoin(shows, eq(shows.itemId, items.id))
    .leftJoin(ownSeason, eq(ownSeason.itemId, items.id))
    .leftJoin(episodes, eq(episodes.itemId, items.id))
    .leftJoin(episodeSeason, eq(episodeSeason.itemId, episodes.seasonId))
    .leftJoin(
      showItem,
      eq(
        showItem.id,
        sql`coalesce(${ownSeason.showId}, ${episodeSeason.showId})`,
      ),
    )
    .leftJoin(
      progress,
      and(eq(progress.itemId, items.id), eq(progress.userId, userId)),
    )
    .leftJoin(
      favourites,
      and(eq(favourites.itemId, items.id), eq(favourites.userId, userId)),
    )
    .leftJoin(
      ratings,
      and(eq(ratings.itemId, items.id), eq(ratings.userId, userId)),
    );
}

type ViewRow = Awaited<ReturnType<typeof selectViews>>[number];

function selectViews(
  db: Database,
  userId: string,
  where: SQL | undefined,
  query: ItemViewQuery,
) {
  let select = withJoins(db.select(viewFields).from(items).$dynamic(), userId)
    .where(where)
    .orderBy(...orderOf(query.sort))
    .offset(query.offset ?? 0);
  if (query.limit !== undefined) select = select.limit(query.limit);
  return select;
}

function toView(row: ViewRow) {
  const {
    showId,
    showTitle,
    showPoster,
    showBackdrop,
    poster,
    backdrop,
    logo,
    thumb,
    positionSeconds,
    completed,
    playCount,
    playedAt,
    favourite,
    rating,
    liked,
    ...item
  } = row;
  return {
    ...item,
    show:
      showId === null || showTitle === null
        ? null
        : {
            id: showId,
            title: showTitle,
            artwork: { poster: showPoster, backdrop: showBackdrop },
          },
    artwork: { poster, backdrop, logo, thumb },
    marks: {
      positionSeconds: positionSeconds ?? 0,
      completed: completed ?? false,
      playCount: playCount ?? 0,
      playedAt,
      favourite,
      rating: rating === null ? null : Number(rating),
      liked,
    },
  };
}

/** One Item as a translation layer shows it: medium fields, selected artwork, provider ids and the caller's marks. */
export type ItemView = ReturnType<typeof toView>;

/** Reads one visible Item; a denied Item reads as absent in translation layers. */
export async function getItemView(
  db: Database,
  userId: string,
  itemId: string,
) {
  const [row] = await db
    .select({ id: items.id })
    .from(items)
    .where(eq(items.id, itemId));
  if (
    !row ||
    !(await checkPermission(db, userId, "view", { type: "item", id: itemId }))
  )
    return undefined;
  const [view] = await selectViews(db, userId, eq(items.id, itemId), {});
  return view ? toView(view) : undefined;
}

/**
 * Lists Item views the user may see, offset-paged, with the total that match.
 * Items outside the user's viewable libraries never match, so a denied id reads as absent.
 */
export async function listItemViews(
  db: Database,
  userId: string,
  query: ItemViewQuery,
): Promise<{ items: ItemView[]; total: number }> {
  const viewable = await viewableLibraryIds(db, userId);
  const where = filtersOf(viewable, query);
  if (viewable.length === 0) return { items: [], total: 0 };
  const matching = db
    .$with("member_items")
    .as(
      withJoins(
        db.select({ id: items.id }).from(items).$dynamic(),
        userId,
      ).where(where),
    );
  const total = db
    .select({ total: count().as("total") })
    .from(matching)
    .as("catalogue_count");
  const page = selectViews(
    db,
    userId,
    inArray(items.id, db.select({ id: matching.id }).from(matching)),
    query,
  ).as("catalogue_page");
  // The count survives an empty/out-of-range page; both sides share one filtered CTE and one statement.
  const rows = await db
    .with(matching)
    .select({ total: total.total, item: page._.selectedFields })
    .from(total)
    .leftJoinLateral(page, sql`true`);
  return {
    items: rows.flatMap((row) => (row.item === null ? [] : [toView(row.item)])),
    total: rows[0]?.total ?? 0,
  };
}

/**
 * Lists the imported video Versions of an Item the user may view, in label
 * order, each with its one File and that File's Streams in index order. A
 * Version split over several Files is left out, since playback cannot open it.
 */
export async function listVersionViews(
  db: Database,
  userId: string,
  itemId: string,
) {
  if (!(await getItemView(db, userId, itemId))) return [];
  return (await loadVersionViews(db, userId, [itemId], true)).get(itemId) ?? [];
}

/**
 * Lists each Item's imported video Versions the user may view, batched into a
 * constant number of queries regardless of Item count. See `listVersionViews`.
 * `externalSubtitles` reads each Item's subtitle folders; list callers pass
 * false so a page never touches the filesystem.
 */
export async function listVersionViewsForItems(
  db: Database,
  userId: string,
  itemIds: string[],
  { externalSubtitles = false } = {},
): Promise<Map<string, VersionView[]>> {
  if (itemIds.length === 0) return new Map();
  return loadVersionViews(db, userId, itemIds, externalSubtitles);
}

async function loadVersionViews(
  db: Database,
  userId: string,
  itemIds: string[],
  externalSubtitles: boolean,
): Promise<Map<string, VersionView[]>> {
  const byItem = new Map<string, VersionView[]>();
  const candidates = await db
    .select({
      id: versions.id,
      itemId: versions.itemId,
      libraryId: versions.libraryId,
    })
    .from(versions)
    .where(
      and(
        inArray(versions.itemId, itemIds),
        eq(versions.origin, "imported"),
        eq(versions.format, "video"),
      ),
    );
  const allowed = await permittedVersionIds(db, userId, "view", candidates);
  if (allowed.size === 0) return byItem;
  const rows = await versionRows(db, itemIds, [...allowed]);
  const filesPerVersion = new Map<string, number>();
  for (const row of rows)
    filesPerVersion.set(row.id, (filesPerVersion.get(row.id) ?? 0) + 1);
  const single = rows.filter((row) => filesPerVersion.get(row.id) === 1);
  if (single.length === 0) return byItem;
  const fileStreams = await db
    .select()
    .from(streams)
    .where(
      inArray(
        streams.fileId,
        single.map((row) => row.fileId),
      ),
    )
    .orderBy(asc(streams.index));
  const subtitles = new Map(
    externalSubtitles
      ? await Promise.all(
          [...new Set(single.map((row) => row.itemId))].map(
            async (itemId) =>
              [itemId, await listSubtitles(db, itemId)] as const,
          ),
        )
      : [],
  );
  // Stored tracks belong to the Item, so the first external index sits past
  // every playable Version's embedded Streams, not one File's.
  const fileItem = new Map(single.map((row) => [row.fileId, row.itemId]));
  const firstExternal = new Map<string, number>();
  for (const stream of fileStreams) {
    const itemId =
      stream.fileId === null ? undefined : fileItem.get(stream.fileId);
    if (itemId !== undefined)
      firstExternal.set(
        itemId,
        Math.max(firstExternal.get(itemId) ?? 0, stream.index + 1),
      );
  }
  for (const row of single) {
    const streamsForFile = fileStreams.filter(
      (stream) => stream.fileId === row.fileId,
    );
    const firstExternalIndex = firstExternal.get(row.itemId) ?? 0;
    const externalSubtitles = (subtitles.get(row.itemId) ?? []).map(
      (track, offset) => ({
        ...track,
        index: firstExternalIndex + offset,
      }),
    );
    byItem.set(row.itemId, [
      ...(byItem.get(row.itemId) ?? []),
      {
        id: row.id,
        libraryId: row.libraryId,
        label: row.label,
        durationSeconds: row.durationSeconds,
        file: {
          id: row.fileId,
          path: resolve(row.rootPath, row.filePath),
          container: row.container,
          bytes: row.bytes,
          durationSeconds: row.fileDurationSeconds,
        },
        streams: streamsForFile,
        externalSubtitles,
      },
    ]);
  }
  return byItem;
}

// Versions joined to their Files and the root path each File's path is relative to.
function versionRows(db: Database, itemIds: string[], permitted: string[]) {
  return db
    .select({
      itemId: versions.itemId,
      libraryId: versions.libraryId,
      id: versions.id,
      label: versions.label,
      durationSeconds: versions.durationSeconds,
      fileId: files.id,
      filePath: files.path,
      rootPath: libraryRoots.path,
      container: files.container,
      bytes: files.bytes,
      fileDurationSeconds: files.durationSeconds,
    })
    .from(versions)
    .innerJoin(files, eq(files.versionId, versions.id))
    .innerJoin(libraryRoots, eq(libraryRoots.id, files.rootId))
    .where(
      and(
        inArray(versions.itemId, itemIds),
        eq(versions.origin, "imported"),
        eq(versions.format, "video"),
        inArray(versions.id, permitted),
      ),
    )
    .orderBy(
      asc(versions.itemId),
      asc(versions.label),
      asc(versions.id),
      asc(files.order),
    );
}

/** One playable Version of an Item with its File and Streams, as a translation layer lists it. */
export type VersionView = {
  id: string;
  libraryId: string;
  label: string;
  durationSeconds: number | null;
  /** The File holding the Version: `path` is absolute, root plus root-relative. */
  file: {
    id: string;
    path: string;
    container: string | null;
    bytes: bigint | number;
    durationSeconds: number | null;
  };
  streams: (typeof streams.$inferSelect)[];
  externalSubtitles: (StoredSubtitle & { index: number })[];
};

/** Lists the libraries a user may view, by name. */
export async function viewableLibraries(db: Database, userId: string) {
  const viewable = await viewableLibraryIds(db, userId);
  if (viewable.length === 0) return [];
  return db
    .select({
      id: libraries.id,
      name: libraries.name,
      medium: libraries.medium,
    })
    .from(libraries)
    .where(inArray(libraries.id, viewable))
    .orderBy(asc(libraries.name), asc(libraries.id));
}

/** Lists distinct browse facets from matching, authorized items and their file streams. */
export async function listLibraryFacets(
  db: Database,
  userId: string,
  query: ItemViewQuery = {},
) {
  const viewable = await viewableLibraryIds(db, userId);
  const where = filtersOf(viewable, query);
  const matching = withJoins(
    db.select({ id: items.id }).from(items).$dynamic(),
    userId,
  ).where(where);
  const values = await withJoins(
    db
      .select({
        genres: sql<
          string[]
        >`coalesce(array_agg(distinct genre) filter (where genre is not null), '{}')`,
        tags: sql<
          string[]
        >`coalesce(array_agg(distinct tag) filter (where tag is not null), '{}')`,
        years: sql<
          number[] | Int32Array
        >`coalesce(array_agg(distinct ${items.year}) filter (where ${items.year} is not null), '{}')`,
        ratings: sql<
          string[]
        >`coalesce(array_agg(distinct ${items.contentRating}) filter (where ${items.contentRating} is not null), '{}')`,
      })
      .from(items)
      .$dynamic(),
    userId,
  )
    .leftJoin(sql`lateral unnest(${items.genres}) as genre`, sql`true`)
    .leftJoin(sql`lateral unnest(${items.tags}) as tag`, sql`true`)
    .where(where);
  const languages = await db
    .selectDistinct({ kind: streams.kind, language: streams.language })
    .from(streams)
    .innerJoin(files, eq(files.id, streams.fileId))
    .where(
      and(
        inArray(files.itemId, matching),
        sql`${streams.language} is not null`,
      ),
    );
  const facets = values[0] ?? { genres: [], tags: [], years: [], ratings: [] };
  return {
    genres: facets.genres.sort(),
    tags: facets.tags.sort(),
    // Bun decodes aggregate integer arrays as Int32Array; adapters need ordinary JSON arrays.
    years: Array.from(facets.years).sort((a, b) => a - b),
    ratings: facets.ratings.sort(),
    audioLanguages: languages
      .filter((row) => row.kind === "audio")
      .flatMap((row) => row.language ?? [])
      .sort(),
    subtitleLanguages: languages
      .filter((row) => row.kind === "subtitle")
      .flatMap((row) => row.language ?? [])
      .sort(),
  };
}

/** Reads contributor metadata and credits only for items the user may view. */
export async function listContributorCredits(
  db: Database,
  userId: string,
  query: ItemViewQuery = {},
) {
  const viewable = await viewableLibraryIds(db, userId);
  const matching = withJoins(
    db.select({ id: items.id }).from(items).$dynamic(),
    userId,
  ).where(filtersOf(viewable, query));
  return db
    .select({
      id: contributors.id,
      name: contributors.name,
      overview: contributors.overview,
      providerIds: sql<Record<string, string>>`(
        select coalesce(jsonb_object_agg(${providerIds.provider}, ${providerIds.value}), '{}'::jsonb)
        from ${providerIds} where ${providerIds.contributorId} = ${contributors.id}
      )`,
      itemId: credits.itemId,
      role: credits.role,
      character: credits.character,
      order: credits.order,
    })
    .from(credits)
    .innerJoin(contributors, eq(contributors.id, credits.contributorId))
    .where(inArray(credits.itemId, matching))
    .orderBy(
      asc(contributors.name),
      asc(credits.role),
      asc(credits.order),
      asc(credits.id),
    );
}

/** Counts matching authorized items by their core kind without loading item rows. */
export async function countItemKinds(
  db: Database,
  userId: string,
  query: ItemViewQuery = {},
) {
  const viewable = await viewableLibraryIds(db, userId);
  return withJoins(
    db.select({ kind: items.kind, total: count() }).from(items).$dynamic(),
    userId,
  )
    .where(filtersOf(viewable, query))
    .groupBy(items.kind);
}
