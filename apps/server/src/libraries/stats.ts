import { stat, statfs } from "node:fs/promises";
import { and, asc, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { Schema } from "effect";
import { episodeSeason, ownSeason, showItem } from "../api/items.ts";
import {
  afterTitle,
  defaultPageSize,
  encodeTitleCursor,
  type Page,
  type TitleKey,
  toPageBy,
} from "../api/pagination.ts";
import {
  type FilesystemSpace as FilesystemSpaceSchema,
  type ItemKind,
  type LibraryMetadataGaps as LibraryMetadataGapsSchema,
  type LibraryStats as LibraryStatsSchema,
  type MetadataGapItem as MetadataGapItemSchema,
  MetadataGap as MetadataGapSchema,
  type SpaceRoot as SpaceRootSchema,
} from "../api/schema.ts";
import { server } from "../auth/access.ts";
import { requirePermission } from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import {
  artwork,
  episodes,
  items,
  libraries,
  libraryRoots,
  providerIds,
} from "../db/schema/index.ts";

/** One Library's dashboard numbers over its playable Items and their imported Versions. */
export type LibraryStats = Schema.Schema.Type<typeof LibraryStatsSchema>;

/** The metadata an Item can be missing, as the Overview counts it. */
export type MetadataGap = Schema.Schema.Type<typeof MetadataGapSchema>;

/** One library's count of Items missing each piece of metadata. */
export type LibraryMetadataGaps = Schema.Schema.Type<
  typeof LibraryMetadataGapsSchema
>;

/** An Item missing a piece of metadata, with what the Overview needs to name and link it. */
export type MetadataGapItem = Schema.Schema.Type<typeof MetadataGapItemSchema>;

type SpaceRoot = Schema.Schema.Type<typeof SpaceRootSchema>;

/** One filesystem holding Library roots, or one root the server can't read. */
export type FilesystemSpace = Schema.Schema.Type<typeof FilesystemSpaceSchema>;

// The gap rules live once so the counts and the item list cannot disagree:
// each names the Item kinds it applies to and the predicate marking it missing.
const noSelectedArtwork = (type: string) =>
  sql`not exists (
    select 1 from ${artwork}
    where ${artwork.itemId} = ${items.id}
      and ${artwork.type} = ${type}
      and ${artwork.selected} = true
  )`;

const gapDefinitions: Record<
  MetadataGap,
  { kinds: readonly Schema.Schema.Type<typeof ItemKind>[]; missing: SQL }
> = {
  poster: { kinds: ["movie", "show"], missing: noSelectedArtwork("poster") },
  backdrop: {
    kinds: ["movie", "show"],
    missing: noSelectedArtwork("backdrop"),
  },
  overview: {
    kinds: ["movie", "show", "episode"],
    missing: sql`(${items.overview} is null or btrim(${items.overview}) = '')`,
  },
  providerIds: {
    kinds: ["movie", "show", "episode"],
    missing: sql`not exists (
      select 1 from ${providerIds}
      where ${providerIds.itemId} = ${items.id}
    )`,
  },
  still: { kinds: ["episode"], missing: noSelectedArtwork("thumb") },
};

async function scopedLibraries(db: Database, actorId: string, id?: string) {
  await requirePermission(db, actorId, "libraries:manage", server);
  return db
    .select({ id: libraries.id })
    .from(libraries)
    .where(id === undefined ? undefined : eq(libraries.id, id))
    .orderBy(asc(libraries.name), asc(libraries.id));
}

type StatsRow = {
  items: number;
  versions: number;
  files: number;
  bytes: number;
  runtime_seconds: number;
  added_last_30_days: number;
  multi_version_items: number;
  resolution: Record<string, number>;
  dynamic_range: Record<string, number>;
  codecs: { codec: string; versions: number }[];
};

/**
 * The Overview's per-Library numbers, in `listLibraries` order. One statement
 * per Library: a primary-video-stream CTE picks each imported Version's first
 * video stream the way `videoVersionLabel` does, and the buckets share its 4K
 * rule extended downward so cropped scope encodes land in the right bucket.
 */
export async function libraryStats(
  db: Database,
  actorId: string,
  id?: string,
): Promise<LibraryStats[]> {
  const scope = await scopedLibraries(db, actorId, id);
  return Promise.all(
    scope.map(async (library) => {
      const result = await db.execute(sql`
        with playable as (
          select ${items.id} from ${items}
          where ${items.libraryId} = ${library.id}
            and ${items.kind} in ('movie', 'episode')
        ),
        imported as (
          select * from versions
          where versions.library_id = ${library.id}
            and versions.origin = 'imported'
        ),
        primary_video as (
          select distinct on (v.id)
            v.id as version_id,
            s.id as stream_id,
            s.width, s.height, s.hdr, s.codec
          from imported v
          left join files f
            on f.version_id = v.id and f.item_id = v.item_id
          left join streams s
            on s.file_id = f.id
            and s.kind = 'video'
            and not coalesce((s.disposition ->> 'attached_pic')::boolean, false)
          order by
            v.id,
            f."order" asc nulls last,
            coalesce((s.disposition ->> 'default')::boolean, false) desc,
            s.index asc nulls last
        )
        select
          (select count(*)::int from playable) as items,
          (select count(*)::int from imported) as versions,
          (select count(*)::int from files f
            join imported v on f.version_id = v.id and f.item_id = v.item_id
          ) as files,
          coalesce((select sum(v.bytes) from imported v), 0)::float8 as bytes,
          coalesce((
            select sum(longest) from (
              select max(v.duration_seconds) as longest
              from imported v group by v.item_id
            ) runtimes
          ), 0)::float8 as runtime_seconds,
          (select count(*)::int from playable p
            join items i on i.id = p.id
            where i.added_at > now() - interval '30 days'
          ) as added_last_30_days,
          (select count(*)::int from (
            select v.item_id from imported v
            group by v.item_id having count(*) > 1
          ) multi) as multi_version_items,
          (
            select coalesce(jsonb_object_agg(bucket, n), '{}'::jsonb)
            from (
              select case
                  when stream_id is null or width is null or height is null
                    then 'unknown'
                  when width >= 3840 or height >= 2160 then 'uhd'
                  when width >= 1920 or height >= 1080 then 'fullHd'
                  when width >= 1280 or height >= 720 then 'hd'
                  else 'lower'
                end as bucket,
                count(*)::int as n
              from primary_video
              group by 1
            ) buckets
          ) as resolution,
          (
            select coalesce(jsonb_object_agg(bucket, n), '{}'::jsonb)
            from (
              select case
                  when hdr = 'dolby-vision' then 'dolbyVision'
                  when hdr in ('hdr10', 'hdr10+', 'hlg') then 'hdr'
                  else 'sdr'
                end as bucket,
                count(*)::int as n
              from primary_video
              where stream_id is not null
              group by 1
            ) ranges
          ) as dynamic_range,
          (
            select coalesce(
              jsonb_agg(
                jsonb_build_object('codec', codec, 'versions', n)
                order by n desc, codec
              ),
              '[]'::jsonb
            )
            from (
              select codec, count(*)::int as n
              from primary_video
              where codec is not null
              group by codec
            ) codecs
          ) as codecs
      `);
      const row = result[0] as StatsRow | undefined;
      if (row === undefined) throw new Error("Stats query returned no row.");
      return {
        libraryId: library.id,
        items: row.items,
        versions: row.versions,
        files: row.files,
        bytes: row.bytes,
        runtimeSeconds: row.runtime_seconds,
        addedLast30Days: row.added_last_30_days,
        multiVersionItems: row.multi_version_items,
        resolution: {
          uhd: row.resolution.uhd ?? 0,
          fullHd: row.resolution.fullHd ?? 0,
          hd: row.resolution.hd ?? 0,
          lower: row.resolution.lower ?? 0,
          unknown: row.resolution.unknown ?? 0,
        },
        dynamicRange: {
          sdr: row.dynamic_range.sdr ?? 0,
          hdr: row.dynamic_range.hdr ?? 0,
          dolbyVision: row.dynamic_range.dolbyVision ?? 0,
        },
        codecs: row.codecs,
      };
    }),
  );
}

/** The Overview's per-Library gap counts, in `listLibraries` order. One statement per Library. */
export async function libraryMetadataGaps(
  db: Database,
  actorId: string,
  id?: string,
): Promise<LibraryMetadataGaps[]> {
  const scope = await scopedLibraries(db, actorId, id);
  return Promise.all(
    scope.map(async (library) => {
      const counts = MetadataGapSchema.literals.map(
        (gap) =>
          sql`(select count(*)::int from ${items}
            where ${items.libraryId} = ${library.id}
              and ${inArray(items.kind, [...gapDefinitions[gap].kinds])}
              and ${gapDefinitions[gap].missing}
          ) as ${sql.identifier(gap)}`,
      );
      const result = await db.execute(sql`select ${sql.join(counts, sql`, `)}`);
      const row = result[0] as Record<string, number> | undefined;
      if (row === undefined)
        throw new Error("Gap counts query returned no row.");
      return { libraryId: library.id, ...row } as LibraryMetadataGaps;
    }),
  );
}

/** Pages one gap's missing-metadata Items by title; an unknown library answers an empty page. */
export async function metadataGapItems(
  db: Database,
  actorId: string,
  input: {
    libraryId: string;
    gap: MetadataGap;
    after?: TitleKey;
    limit?: number;
  },
): Promise<Page<MetadataGapItem>> {
  await requirePermission(db, actorId, "libraries:manage", server);
  const [library] = await db
    .select({ id: libraries.id })
    .from(libraries)
    .where(eq(libraries.id, input.libraryId));
  if (library === undefined) return { items: [], cursor: null };
  const gap = gapDefinitions[input.gap];
  const limit = input.limit ?? defaultPageSize;
  const rows = await db
    .select({
      id: items.id,
      kind: items.kind,
      title: items.title,
      year: items.year,
      parentId: items.parentId,
      showId: showItem.id,
      showTitle: showItem.title,
      seasonNumber: sql<
        number | null
      >`coalesce(${ownSeason.seasonNumber}, ${episodeSeason.seasonNumber})`,
      episodeNumber: episodes.episodeNumber,
    })
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
    .where(
      and(
        eq(items.libraryId, input.libraryId),
        inArray(items.kind, [...gap.kinds]),
        gap.missing,
        input.after === undefined ? undefined : afterTitle(input.after),
      ),
    )
    .orderBy(asc(items.title), asc(items.id))
    .limit(limit + 1);
  return toPageBy(
    rows.map(({ showId, showTitle, ...row }) => ({
      ...row,
      show:
        showId === null || showTitle === null
          ? null
          : { id: showId, title: showTitle },
    })),
    limit,
    (row) => encodeTitleCursor({ title: row.title, id: row.id }),
  );
}

/** Free space on every filesystem holding a Library root, measured in the API process. */
export async function libraryFreeSpace(
  db: Database,
  actorId: string,
): Promise<FilesystemSpace[]> {
  await requirePermission(db, actorId, "libraries:manage", server);
  const roots = await db
    .select({
      id: libraryRoots.id,
      libraryId: libraryRoots.libraryId,
      libraryName: libraries.name,
      path: libraryRoots.path,
    })
    .from(libraryRoots)
    .innerJoin(libraries, eq(libraries.id, libraryRoots.libraryId))
    .orderBy(
      asc(libraries.name),
      asc(libraries.id),
      asc(libraryRoots.position),
    );
  // The union's roots are readonly; groups accumulate into mutable lists.
  type Available = Omit<
    Extract<FilesystemSpace, { state: "available" }>,
    "roots"
  > & { roots: SpaceRoot[] };
  const filesystems: FilesystemSpace[] = [];
  const byDevice = new Map<number, Available>();
  for (const root of roots) {
    try {
      const info = await stat(root.path);
      const fs = await statfs(root.path);
      const existing = byDevice.get(info.dev);
      if (existing !== undefined) {
        existing.roots.push(root);
        continue;
      }
      const space = {
        state: "available" as const,
        totalBytes: Number(fs.blocks) * fs.bsize,
        availableBytes: Number(fs.bavail) * fs.bsize,
        usedBytes: (Number(fs.blocks) - Number(fs.bfree)) * fs.bsize,
        roots: [root],
      };
      byDevice.set(info.dev, space);
      filesystems.push(space);
    } catch {
      filesystems.push({ state: "unavailable", roots: [root] });
    }
  }
  return filesystems;
}
