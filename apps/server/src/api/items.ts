import {
  and,
  asc,
  desc,
  eq,
  inArray,
  type SQL,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Schema } from "effect";
import { Effect } from "effect";
import { AuthError } from "../auth/errors.ts";
import {
  checkPermission,
  loadPermissionScope,
  type PermissionScope,
  requirePermission,
  viewableLibraryIds,
} from "../auth/permissions.ts";
import type { authenticate } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import {
  artwork,
  contributors,
  credits,
  episodes,
  files,
  items,
  progress,
  seasons,
  streams,
  versions,
} from "../db/schema/index.ts";
import { homeLibraryId, inLibraries } from "../libraries/membership.ts";
import { ApiError, fromHost } from "./errors.ts";
import {
  after,
  afterTitle,
  decodeCursor,
  decodeTitleCursor,
  defaultPageSize,
  encodeCursor,
  encodeTitleCursor,
  toPageBy,
} from "./pagination.ts";
import type { ItemKind, ItemSort } from "./schema.ts";

/** The authenticated caller the middleware places in context. */
export type Caller = Awaited<ReturnType<typeof authenticate>>;

/** The decoded items.list input. */
export type ListItemsInput = {
  readonly libraryId?: string;
  readonly kind?: Schema.Schema.Type<typeof ItemKind>;
  readonly sort?: Schema.Schema.Type<typeof ItemSort>;
  readonly limit?: number;
  readonly cursor?: string;
};

// Instants cross the API as the database's own UTC text at microsecond
// precision, so a cursor never rounds a timestamp the driver truncated.
const instantText = (column: SQLWrapper) =>
  sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

// A single-table select renders columns unqualified, which would bind to
// artwork's own id inside the subquery, so the owner is named in full.
const selectedArtwork = (owner: "items" | "show_item", type: string) =>
  sql<string | null>`(
    select ${artwork.id}
    from ${artwork}
    where ${artwork.itemId} = ${sql.identifier(owner)}."id"
      and ${artwork.type} = ${type}
      and ${artwork.selected} = true
    limit 1
  )`;

const cardFields = {
  id: items.id,
  kind: items.kind,
  homeLibraryId: homeLibraryId(),
  title: items.title,
  year: items.year,
  addedAt: instantText(items.addedAt),
  posterArtworkId: selectedArtwork("items", "poster"),
};

// Hero and landscape artwork sit on browse cards: detail composes a card, so
// the fields live here rather than in detailFields.
const heroFields = {
  backdropArtworkId: selectedArtwork("items", "backdrop"),
  logoArtworkId: selectedArtwork("items", "logo"),
  thumbArtworkId: selectedArtwork("items", "thumb"),
};

// A Season names its Show directly; an Episode reaches it through its Season.
// Exported for queries that place Items the same way, such as the gap list.
export const ownSeason = alias(seasons, "own_season");
export const episodeSeason = alias(seasons, "episode_season");
export const showItem = alias(items, "show_item");

const browseFields = {
  ...cardFields,
  ...heroFields,
  parentId: items.parentId,
  seasonNumber: sql<
    number | null
  >`coalesce(${ownSeason.seasonNumber}, ${episodeSeason.seasonNumber})`,
  episodeNumber: episodes.episodeNumber,
  episodeEndNumber: episodes.episodeEndNumber,
  showId: showItem.id,
  showTitle: showItem.title,
  showPosterArtworkId: selectedArtwork("show_item", "poster"),
  showBackdropArtworkId: selectedArtwork("show_item", "backdrop"),
  showLogoArtworkId: selectedArtwork("show_item", "logo"),
};

/** Reads browse cards: item cards with their numbers and owning Show. */
export async function browseCards(
  db: Database,
  where: SQL | undefined,
  orderBy: SQL[] = [],
  limit?: number,
) {
  const query = db
    .select(browseFields)
    .from(items)
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
    .where(where)
    .orderBy(...orderBy);
  const rows = await (limit === undefined ? query : query.limit(limit));
  return rows.map(
    ({
      showId,
      showTitle,
      showPosterArtworkId,
      showBackdropArtworkId,
      showLogoArtworkId,
      ...card
    }) => ({
      ...card,
      show:
        showId === null || showTitle === null
          ? null
          : {
              id: showId,
              title: showTitle,
              posterArtworkId: showPosterArtworkId,
              backdropArtworkId: showBackdropArtworkId,
              logoArtworkId: showLogoArtworkId,
            },
    }),
  );
}

/** Reads browse cards for ids the caller may already view, in the order given. */
export async function browseCardsById(db: Database, ids: readonly string[]) {
  if (ids.length === 0) return [];
  const cards = await browseCards(db, inArray(items.id, [...ids]));
  const byId = new Map(cards.map((card) => [card.id, card]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

const detailFields = {
  overview: items.overview,
  contentRating: items.contentRating,
  genres: items.genres,
  tags: items.tags,
  metadataState: items.metadataState,
  updatedAt: instantText(items.updatedAt),
};

// Each sort owns its order, its keyset predicate and its cursor encoding.
// An undefined `after` with a cursor means the cursor belongs to another sort.
function sortPlan(sort: ListItemsInput["sort"], cursor: string | undefined) {
  if (sort === "title") {
    const key = cursor === undefined ? undefined : decodeTitleCursor(cursor);
    return {
      after: key === undefined ? undefined : afterTitle(key),
      orderBy: [asc(items.title), asc(items.id)],
      cursorOf: (row: { title: string; id: string }) => encodeTitleCursor(row),
    };
  }
  const key = cursor === undefined ? undefined : decodeCursor(cursor);
  return {
    after: key === undefined ? undefined : after(key),
    orderBy: [desc(items.addedAt), desc(items.id)],
    cursorOf: (row: { addedAt: string; id: string }) => encodeCursor(row),
  };
}

/** Lists item cards newest first or by title, paginated by the opaque cursor. */
export function listItemCards(
  db: Database,
  caller: Caller,
  input: ListItemsInput,
) {
  return Effect.gen(function* () {
    // Without a library the list is scoped to every library the caller may view.
    const scope = yield* fromHost(async () => {
      if (input.libraryId !== undefined) {
        await requirePermission(db, caller.user.id, "view", {
          type: "library",
          id: input.libraryId,
        });
        return inLibraries([input.libraryId]);
      }
      const viewable = await viewableLibraryIds(db, caller.user.id);
      if (viewable.length === 0) throw new AuthError("FORBIDDEN");
      return inLibraries(viewable);
    });
    const limit = input.limit ?? defaultPageSize;
    const plan = sortPlan(input.sort, input.cursor);
    if (input.cursor !== undefined && plan.after === undefined)
      return yield* new ApiError({
        code: "BAD_REQUEST",
        reason: "Unknown cursor.",
      });
    const rows = yield* fromHost(() =>
      db
        .select(cardFields)
        .from(items)
        .where(
          and(
            scope,
            input.kind === undefined ? undefined : eq(items.kind, input.kind),
            plan.after,
          ),
        )
        .orderBy(...plan.orderBy)
        .limit(limit + 1),
    );
    return toPageBy(rows, limit, plan.cursorOf);
  });
}

/** Enriches browse cards with the overview, first viewable imported Version's runtime and the caller's progress a detail child shows. */
export async function detailChildren(
  db: Database,
  userId: string,
  permissions: PermissionScope,
  cards: Awaited<ReturnType<typeof browseCards>>,
) {
  if (cards.length === 0) return [];
  const ids = cards.map((card) => card.id);
  const [overviews, runtimes, marks] = await Promise.all([
    db
      .select({ id: items.id, overview: items.overview })
      .from(items)
      .where(inArray(items.id, ids)),
    // The detail orders Versions the same way; the first row per item wins.
    db
      .select({
        id: versions.id,
        itemId: versions.itemId,
        libraryId: versions.libraryId,
        durationSeconds: versions.durationSeconds,
      })
      .from(versions)
      .where(
        and(inArray(versions.itemId, ids), eq(versions.origin, "imported")),
      )
      .orderBy(versions.itemId, asc(versions.label), asc(versions.id)),
    db
      .select({
        itemId: progress.itemId,
        positionSeconds: progress.positionSeconds,
        completed: progress.completed,
        updatedAt: instantText(progress.updatedAt),
      })
      .from(progress)
      .where(and(inArray(progress.itemId, ids), eq(progress.userId, userId))),
  ]);
  const overviewOf = new Map(overviews.map((row) => [row.id, row]));
  const permitted = await permissions.versionIds("view", runtimes);
  const runtimeOf = new Map<string, (typeof runtimes)[number]>();
  for (const runtime of runtimes)
    if (permitted.has(runtime.id) && !runtimeOf.has(runtime.itemId))
      runtimeOf.set(runtime.itemId, runtime);
  const markOf = new Map(marks.map((row) => [row.itemId, row]));
  return cards.map((card) => {
    const mark = markOf.get(card.id);
    return {
      ...card,
      overview: overviewOf.get(card.id)?.overview ?? null,
      durationSeconds: runtimeOf.get(card.id)?.durationSeconds ?? null,
      progress:
        mark === undefined
          ? null
          : {
              positionSeconds: mark.positionSeconds,
              completed: mark.completed,
              updatedAt: mark.updatedAt,
            },
    };
  });
}

/** Reads one Item's detail after checking its inherited Access rules. */
export function getItemDetail(db: Database, caller: Caller, id: string) {
  return Effect.gen(function* () {
    const [card] = yield* fromHost(() => browseCards(db, eq(items.id, id)));
    if (!card) return yield* new ApiError({ code: "NOT_FOUND" });
    yield* fromHost(() =>
      requirePermission(db, caller.user.id, "view", {
        type: "item",
        id,
      }),
    );
    const [[detail], itemCredits, candidates, childCards, canDownload] =
      yield* fromHost(() =>
        Promise.all([
          db.select(detailFields).from(items).where(eq(items.id, id)),
          db
            .select({
              contributorId: contributors.id,
              name: contributors.name,
              role: credits.role,
              character: credits.character,
            })
            .from(credits)
            .innerJoin(contributors, eq(contributors.id, credits.contributorId))
            .where(eq(credits.itemId, id))
            .orderBy(
              sql`${credits.role} <> 'actor'`,
              asc(credits.role),
              asc(credits.order),
              asc(credits.id),
            ),
          db
            .select({
              id: versions.id,
              itemId: versions.itemId,
              libraryId: versions.libraryId,
              label: versions.label,
              format: versions.format,
              durationSeconds: versions.durationSeconds,
              bytes: versions.bytes,
            })
            .from(versions)
            .where(
              and(eq(versions.itemId, id), eq(versions.origin, "imported")),
            )
            .orderBy(asc(versions.label), asc(versions.id)),
          browseCards(db, eq(items.parentId, id), [
            sql`${ownSeason.seasonNumber} nulls last`,
            sql`${episodes.episodeNumber} nulls last`,
            asc(items.title),
            asc(items.id),
          ]),
          checkPermission(db, caller.user.id, "download", {
            type: "item",
            id,
          }),
        ]),
      );
    if (!detail) return yield* new ApiError({ code: "NOT_FOUND" });
    const permissions = yield* fromHost(() =>
      loadPermissionScope(db, caller.user.id),
    );
    const [visibleVersions, visibleChildren] = yield* fromHost(() =>
      Promise.all([
        permissions.versionIds("view", candidates),
        permissions.itemIds(
          "view",
          childCards.map((child) => child.id),
        ),
      ]),
    );
    const itemVersions = candidates.filter((version) =>
      visibleVersions.has(version.id),
    );
    const playableVersions = yield* fromHost(() =>
      permissions.versionIds("play", itemVersions),
    );
    const children = childCards.filter((child) =>
      visibleChildren.has(child.id),
    );
    const versionIds = itemVersions.map((version) => version.id);
    const [versionFiles, versionStreams] = yield* fromHost(() =>
      versionIds.length === 0
        ? Promise.all([Promise.resolve([]), Promise.resolve([])])
        : Promise.all([
            db
              .select({
                versionId: files.versionId,
                container: files.container,
              })
              .from(files)
              .where(inArray(files.versionId, versionIds))
              .orderBy(asc(files.order)),
            db
              .select({
                versionId: streams.versionId,
                index: streams.index,
                kind: streams.kind,
                codec: streams.codec,
                profile: streams.profile,
                language: streams.language,
                title: streams.title,
                channels: streams.channels,
                width: streams.width,
                height: streams.height,
                hdr: streams.hdr,
                disposition: streams.disposition,
              })
              .from(streams)
              .where(inArray(streams.versionId, versionIds))
              .orderBy(asc(streams.index)),
          ]),
    );
    const containerOf = new Map<string, string | null>();
    for (const file of versionFiles)
      if (!containerOf.has(file.versionId))
        containerOf.set(file.versionId, file.container);
    const streamsOf = new Map<string, typeof versionStreams>();
    for (const stream of versionStreams) {
      const list = streamsOf.get(stream.versionId) ?? [];
      list.push(stream);
      streamsOf.set(stream.versionId, list);
    }
    const enriched = yield* fromHost(() =>
      detailChildren(db, caller.user.id, permissions, children),
    );
    return {
      ...card,
      ...detail,
      credits: itemCredits,
      canDownload,
      // JSON has no bigint; a byte count stays exact below 2^53.
      versions: itemVersions.map(({ itemId: _itemId, ...version }) => ({
        ...version,
        playable: playableVersions.has(version.id),
        bytes: Number(version.bytes),
        container: containerOf.get(version.id) ?? null,
        streams: (streamsOf.get(version.id) ?? []).map(
          ({ versionId, disposition, ...stream }) => ({
            ...stream,
            default: disposition.default === true,
            forced: disposition.forced === true,
          }),
        ),
      })),
      children: enriched,
    };
  });
}

/** The most results a search answers with. */
export const searchLimit = 24;

/**
 * Finds the Items of the given kinds the caller may view whose titles resemble
 * the query, best match first, as browse cards so a Season or Episode carries
 * its Show. Trigram similarity forgives a misspelling; word similarity lets a
 * prefix or one word of a longer title match.
 */
export function searchItems(
  db: Database,
  caller: Caller,
  query: string,
  kinds: readonly Schema.Schema.Type<typeof ItemKind>[] = ["movie", "show"],
) {
  return Effect.gen(function* () {
    const viewable = yield* fromHost(() =>
      viewableLibraryIds(db, caller.user.id),
    );
    if (viewable.length === 0) return [];
    // Match on the Item's own title only: matching the Show title would bypass
    // the title trigram index.
    return yield* fromHost(() =>
      browseCards(
        db,
        and(
          inLibraries(viewable),
          inArray(items.kind, [...kinds]),
          sql`(${items.title} % ${query} or ${query} <% ${items.title})`,
        ),
        [
          sql`word_similarity(${query}, ${items.title}) desc`,
          sql`similarity(${items.title}, ${query}) desc`,
          asc(items.title),
          asc(items.id),
        ],
        searchLimit,
      ),
    );
  });
}
