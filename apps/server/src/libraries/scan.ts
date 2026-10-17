import { posix } from "node:path";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { AuthError } from "../auth/errors.ts";
import { lockCatalogue } from "../db/catalogue-lock.ts";
import type { Database } from "../db/client.ts";
import {
  episodes,
  files,
  itemAncestors,
  itemFolders,
  items,
  libraries,
  libraryRoots,
  probeCache,
  providerIds,
  type ScanChange,
  scanFailures,
  seasons,
  streams,
  versions,
} from "../db/schema/index.ts";
import {
  type DeletedArtworkFile,
  insertItem,
  pruneEmptiedItems,
} from "../db/tree.ts";
import type { ScanRules } from "../mediums/medium.ts";
import { groupMoviePaths, moviesMedium } from "../mediums/movies.ts";
import {
  groupShowPaths,
  mergeEpisodeRanges,
  showsScan,
} from "../mediums/shows.ts";
import { videoVersionLabel } from "../mediums/video-common/labels.ts";
import {
  type ProbeResult,
  probeVideo,
  UnreadableMediaError,
} from "../mediums/video-common/probe.ts";
import { parseTitle, titleKey } from "../mediums/video-common/titles.ts";
import { removeArtworkFiles } from "../metadata/artwork-store.ts";
import {
  applyScanChanges,
  findItemByProviderIds,
  setItemProviderIds,
  updateItemCanonicalFolder,
} from "./changes.ts";
import { queueKeyframeIndex } from "./keyframe-index.ts";
import {
  itemLocation,
  retireEmptyLocations,
  setItemLocation,
} from "./locations.ts";
import { inLibraries } from "./membership.ts";
import { type ProbedLibraryFile, probeLibraryFile } from "./probe-cache.ts";
import {
  type LibraryRoot,
  type RootedPath,
  rootedKey,
  rootsOf,
} from "./roots.ts";
import { queuedScanMoveSources, scanAssertions } from "./scan-payload.ts";
import { persistScanTimelines } from "./timelines.ts";
import {
  type LibraryFile,
  MissingLibraryPathError,
  readLibraryFile,
  walkLibrary,
} from "./walker.ts";

/** A walked file in one root, with the root's folder name. */
export type RootedFile = LibraryFile & { rootId: string; rootName: string };

/** A probed file in one root. */
export type ProbedRootedFile = ProbedLibraryFile & { rootId: string };

/** Where a scan reads its files: the local disk, or a watcher's report. */
export type ScanSource = {
  /** The Library's roots revision when this source read its roots; a write under a newer revision is refused. */
  rootsRevision: number;
  /** Lists accepted media files under a root-relative scope in every root; a missing scope lists none. */
  walk(path: string, recursive: boolean): Promise<RootedFile[]>;
  /** Returns one walked file with its probe result. */
  probe(file: RootedPath): Promise<ProbedRootedFile>;
  /** Fails when a probed or skipped file changed before the write. Runs under the write lock. */
  verify(file: LibraryFile & RootedPath): Promise<void>;
  /** Fails when an empty scope gained files in any root before the write. Runs under the write lock. */
  confirmEmpty(path: string, recursive: boolean): Promise<void>;
  /** Fails when a file the walk missed exists again before the write. Runs under the write lock. */
  confirmMissing(files: readonly RootedPath[]): Promise<void>;
  /** Whether a stored File outside the scope still exists. */
  exists(file: RootedPath): Promise<boolean>;
};

/** Optional collaborators and queued changes for one directory scan. */
export type ScanDirectoryOptions = {
  probe?: typeof probeVideo;
  source?: ScanSource;
  changes?: readonly ScanChange[];
  reconcileMissing?: boolean;
};

/** The scan rules one library-relative scope of a medium uses. */
export function scanScope(medium: (typeof libraries.$inferSelect)["medium"]) {
  return {
    rules: medium === "movies" ? moviesMedium.scan : showsScan,
  };
}

/** Whether a walk of this library-relative scope would reach the path. */
export const inScope = (
  rules: ScanRules,
  scope: string,
  recursive: boolean,
  path: string,
) =>
  recursive
    ? scope === "." || path.startsWith(`${scope}/`)
    : posix.dirname(path) === scope ||
      rules.itemFolder(posix.dirname(path)) === scope;

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Replace one File's Stream inventory from a probe, reusing (fileId, index) ids. */
async function upsertFileStreams(
  tx: Transaction,
  versionId: string,
  fileId: string,
  probe: ProbeResult,
) {
  const indexes: number[] = [];
  for (const stream of probe.streams) {
    indexes.push(stream.index);
    const fields = {
      versionId,
      kind: stream.kind,
      codec: stream.codec,
      profile: stream.profile,
      level: stream.level,
      language: stream.language,
      title: stream.title,
      bitrate: stream.bitrate === null ? null : BigInt(stream.bitrate),
      disposition: stream.disposition,
      width: stream.width,
      height: stream.height,
      frameRateNumerator: stream.frameRateNumerator,
      frameRateDenominator: stream.frameRateDenominator,
      hdr: stream.hdr,
      dvProfile: stream.dvProfile,
      channels: stream.channels,
      channelLayout: stream.channelLayout,
      sampleRate: stream.sampleRate,
    };
    await tx
      .insert(streams)
      .values({ fileId, index: stream.index, ...fields })
      .onConflictDoUpdate({
        target: [streams.fileId, streams.index],
        targetWhere: sql`${streams.fileId} is not null`,
        set: fields,
      });
  }
  if (indexes.length === 0) {
    await tx.delete(streams).where(eq(streams.fileId, fileId));
  } else {
    await tx
      .delete(streams)
      .where(
        and(eq(streams.fileId, fileId), notInArray(streams.index, indexes)),
      );
  }
}

/** Re-walks the requested scope inside the write lock before an empty result deletes rows. */
async function confirmScopeEmpty(
  rootPath: string,
  rules: ScanRules,
  path: string,
  recursive: boolean,
): Promise<void> {
  try {
    for await (const file of walkLibrary(rootPath, rules, {
      path,
      recursive,
    })) {
      if (file.path !== "") {
        throw new Error("Library directory changed before scan write.");
      }
    }
  } catch (error) {
    if (
      error instanceof MissingLibraryPathError &&
      error.scope === "requested"
    ) {
      return;
    }
    throw error;
  }
}

/**
 * The index state a Version write carries: the probe-cache row re-read inside
 * the write transaction, under the same Library lock the keyframe-index job
 * holds. An index that landed between the probe and the write is kept; a
 * changed file's fresh cache row has none, so it stays pending.
 */
async function versionIndexState(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  member: ProbedRootedFile,
): Promise<{ keyframesSeconds: number[] | null; lazyIndexPending: boolean }> {
  const [entry] = await tx
    .select({ result: probeCache.result })
    .from(probeCache)
    .where(
      and(
        eq(probeCache.rootId, member.rootId),
        eq(probeCache.path, member.path),
      ),
    );
  // A cached null is a completed read of an unsupported container, not a
  // missing one; only an unread cache falls back to the probe snapshot.
  const cached = entry?.result.keyframesSeconds;
  const keyframesSeconds =
    cached !== undefined ? cached : member.probe.keyframesSeconds;
  return {
    keyframesSeconds: keyframesSeconds ?? null,
    lazyIndexPending: keyframesSeconds === undefined,
  };
}

/** Reads a Library's roots on the local disk through the walker and the persistent probe cache. */
export function localScanSource(
  db: Database,
  roots: readonly LibraryRoot[],
  rootsRevision: number,
  medium: (typeof libraries.$inferSelect)["medium"],
  probe: typeof probeVideo = probeVideo,
): ScanSource {
  const { rules } = scanScope(medium);
  const rootOf = (rootId: string) => {
    const root = roots.find((candidate) => candidate.id === rootId);
    if (root === undefined) throw new Error(`Unknown library root ${rootId}.`);
    return root;
  };
  const exists = async (file: RootedPath) => {
    try {
      await readLibraryFile(rootOf(file.rootId).path, file.path);
      return true;
    } catch (error) {
      if (error instanceof MissingLibraryPathError) return false;
      throw error;
    }
  };
  return {
    rootsRevision,
    async walk(path, recursive) {
      const walked: RootedFile[] = [];
      for (const root of roots) {
        try {
          for await (const file of walkLibrary(root.path, rules, {
            path,
            recursive,
          }))
            walked.push({
              ...file,
              rootId: root.id,
              rootName: posix.basename(root.path),
            });
        } catch (error) {
          if (
            !(error instanceof MissingLibraryPathError) ||
            error.scope !== "requested"
          )
            throw error;
        }
      }
      return walked;
    },
    probe: async (file) => ({
      ...(await probeLibraryFile(db, rootOf(file.rootId), file.path, probe)),
      rootId: file.rootId,
    }),
    async verify(file) {
      const current = await readLibraryFile(
        rootOf(file.rootId).path,
        file.path,
      );
      if (
        current.bytes !== file.bytes ||
        current.modifiedNs !== file.modifiedNs
      )
        throw new Error("File changed before scan write.");
    },
    async confirmEmpty(path, recursive) {
      for (const root of roots)
        await confirmScopeEmpty(root.path, rules, path, recursive);
    },
    async confirmMissing(missing) {
      for (const file of missing)
        if (await exists(file))
          throw new Error("Library directory changed before scan write.");
    },
    exists,
  };
}

/**
 * Reads a Library's own roots on the local disk. The roots and their
 * revision come from one statement, so a scan never pairs old roots with
 * the revision a root edit already bumped.
 */
export async function libraryScanSource(
  db: Database,
  library: Pick<typeof libraries.$inferSelect, "id" | "medium">,
  probe: typeof probeVideo = probeVideo,
) {
  const rows = await db
    .select({
      id: libraryRoots.id,
      path: libraryRoots.path,
      rootsRevision: libraries.rootsRevision,
    })
    .from(libraries)
    .innerJoin(libraryRoots, eq(libraryRoots.libraryId, libraries.id))
    .where(eq(libraries.id, library.id))
    .orderBy(asc(libraryRoots.position), asc(libraryRoots.id));
  return localScanSource(
    db,
    rows.map(({ id, path }) => ({ id, path })),
    rows[0]?.rootsRevision ?? 0,
    library.medium,
    probe,
  );
}

/** The drizzle condition matching any of these (root, path) pairs. */
const rootedPairs = (paths: readonly RootedPath[]) =>
  or(
    ...paths.map((file) =>
      and(eq(files.rootId, file.rootId), eq(files.path, file.path)),
    ),
  );

/**
 * Finds the Show whose live Files all sit at these paths: a queued folder
 * move re-paths Files before the scan finds their Show. A Show with a
 * File still on disk elsewhere only lost some of them, so it stays put.
 * Rows of Files already gone from disk do not count.
 */
async function findShowOwningFiles(
  tx: Transaction,
  libraryId: string,
  paths: readonly RootedPath[],
  source: ScanSource,
) {
  if (paths.length === 0) return undefined;
  const [owner] = await tx
    .select({ item: items })
    .from(files)
    .innerJoin(itemAncestors, eq(itemAncestors.descendantId, files.itemId))
    .innerJoin(
      items,
      and(eq(items.id, itemAncestors.ancestorId), eq(items.kind, "show")),
    )
    .where(and(eq(files.libraryId, libraryId), rootedPairs(paths)))
    .orderBy(asc(items.id))
    .limit(1);
  if (owner === undefined) return undefined;
  const elsewhere = await tx
    .select({ rootId: files.rootId, path: files.path })
    .from(files)
    .innerJoin(itemAncestors, eq(itemAncestors.descendantId, files.itemId))
    .where(
      and(
        eq(itemAncestors.ancestorId, owner.item.id),
        eq(files.libraryId, libraryId),
        sql`not (${rootedPairs(paths)})`,
      ),
    );
  for (const file of elsewhere) if (await source.exists(file)) return undefined;
  return owner.item;
}

/** Finds the Movie that already owns any of these Files, matched by root and path. */
async function findMovieOwningFiles(
  tx: Transaction,
  libraryId: string,
  paths: readonly RootedPath[],
) {
  if (paths.length === 0) return undefined;
  const owners = await tx
    .select({ item: items })
    .from(files)
    .innerJoin(items, and(eq(items.id, files.itemId), eq(items.kind, "movie")))
    .where(and(eq(files.libraryId, libraryId), rootedPairs(paths)))
    .orderBy(asc(items.id));
  return owners[0]?.item;
}

/** One root Item of a kind and its explicit provider ids, for the title-key fallback. */
async function rootItemCandidates(
  tx: Transaction,
  libraryId: string,
  kind: "movie" | "show",
) {
  const roots = await tx
    .select({
      id: items.id,
      canonicalFolder: itemFolders.canonicalFolder,
      titleKey: sql<string>`${itemFolders.titleKey}`,
    })
    .from(items)
    .innerJoin(itemFolders, eq(itemFolders.itemId, items.id))
    .innerJoin(libraryRoots, eq(libraryRoots.id, itemFolders.rootId))
    .where(
      and(
        eq(libraryRoots.libraryId, libraryId),
        eq(items.kind, kind),
        isNull(items.parentId),
        isNotNull(itemFolders.titleKey),
      ),
    );
  const ids = roots.map((row) => row.id);
  const explicit =
    ids.length === 0
      ? []
      : await tx
          .select({
            itemId: providerIds.itemId,
            provider: providerIds.provider,
            value: providerIds.value,
          })
          .from(providerIds)
          .where(
            and(
              inArray(providerIds.itemId, ids),
              eq(providerIds.metadataDerived, false),
            ),
          );
  const byItem = new Map<string, { provider: string; value: string }[]>();
  for (const row of explicit) {
    if (row.itemId === null) continue;
    const list = byItem.get(row.itemId) ?? [];
    list.push({ provider: row.provider, value: row.value });
    byItem.set(row.itemId, list);
  }
  return roots.map((row) => ({
    ...row,
    providerIds: byItem.get(row.id) ?? [],
  }));
}

/**
 * Finds one root Item a group falls back to. A titled group (key set)
 * matches a candidate with the same effective key, or one explicit
 * provider id in common. A folder group (empty key) matches only titled
 * candidates, by equal title key or a shared provider id. A candidate
 * another group of this scan already took never matches again.
 */
function fallbackCandidate(
  candidates: Awaited<ReturnType<typeof rootItemCandidates>>,
  group: {
    titleKey: string;
    title: string;
    year: number | null;
    providerIds: Record<string, string>;
  },
  claimed: ReadonlySet<string>,
) {
  const shares = (candidate: {
    providerIds: { provider: string; value: string }[];
  }) =>
    candidate.providerIds.some(
      (id) => group.providerIds[id.provider] === id.value,
    );
  const effectiveKey = (candidate: {
    canonicalFolder: string;
    titleKey: string;
  }) => {
    if (candidate.titleKey !== "") return candidate.titleKey;
    const parsed = parseTitle(posix.basename(candidate.canonicalFolder));
    return titleKey(parsed.title, parsed.year);
  };
  const matches = candidates.filter((candidate) => {
    if (claimed.has(candidate.id)) return false;
    if (group.titleKey !== "") {
      return effectiveKey(candidate) === group.titleKey || shares(candidate);
    }
    return (
      candidate.titleKey !== "" &&
      (candidate.titleKey === titleKey(group.title, group.year) ||
        shares(candidate))
    );
  });
  const unique = [
    ...new Map(matches.map((candidate) => [candidate.id, candidate])).values(),
  ];
  return unique.length === 1 ? unique[0] : undefined;
}

/**
 * Whether these group Files cover the Item subtree's home root: the
 * lowest-position root among the roots of the subtree's imported Files
 * plus the group's Files, when the group also names every imported File
 * the subtree still holds there. A partial cover moves nothing: the
 * other Files belong to sibling groups of the same scan. A File gone
 * from disk waits for reconciliation instead of blocking the move. A
 * group File another Item already owns in the home root blocks the
 * move too.
 */
async function coversHomeRoot(
  tx: Transaction,
  positions: ReadonlyMap<string, number>,
  source: ScanSource,
  itemId: string,
  groupFiles: readonly RootedPath[],
): Promise<boolean> {
  const held = await tx
    .selectDistinct({ rootId: files.rootId, path: files.path })
    .from(files)
    .innerJoin(itemAncestors, eq(itemAncestors.descendantId, files.itemId))
    .innerJoin(
      versions,
      and(eq(versions.id, files.versionId), eq(versions.origin, "imported")),
    )
    .where(eq(itemAncestors.ancestorId, itemId));
  let home: string | undefined;
  for (const file of [...held, ...groupFiles]) {
    const position = positions.get(file.rootId);
    if (position === undefined) continue;
    if (home === undefined || position < (positions.get(home) ?? 0))
      home = file.rootId;
  }
  if (home === undefined || !groupFiles.some((file) => file.rootId === home)) {
    return false;
  }
  const keys = new Set(groupFiles.map(rootedKey));
  for (const file of held) {
    if (file.rootId !== home || !(await source.exists(file))) continue;
    if (!keys.has(rootedKey(file))) return false;
  }
  const [foreign] = await tx
    .select({ id: files.id })
    .from(files)
    .leftJoin(
      itemAncestors,
      and(
        eq(itemAncestors.descendantId, files.itemId),
        eq(itemAncestors.ancestorId, itemId),
      ),
    )
    .where(
      and(
        isNull(itemAncestors.ancestorId),
        rootedPairs(groupFiles.filter((file) => file.rootId === home)),
      ),
    )
    .limit(1);
  return foreign === undefined;
}

/** The ids of queued add and move changes that name one of the group's Files. Delete ids apply only to the Files they name, even in a lone group: the group that survives a delete keeps its own identity. */
function groupChangeProviderIds(
  changes: readonly ScanChange[],
  groupFiles: readonly RootedPath[],
  singleGroup: boolean,
): Record<string, string> {
  const keys = new Set(groupFiles.map(rootedKey));
  const merged: Record<string, string> = {};
  for (const change of changes) {
    if (change.kind === "delete" && !keys.has(rootedKey(change))) continue;
    if (!singleGroup && !keys.has(rootedKey(change))) continue;
    Object.assign(merged, change.providerIds);
  }
  return merged;
}

/** Merges groups' provider ids, or undefined when two groups give one provider different values. Empty values assert nothing. */
function mergeProviderIds(
  assertions: readonly Record<string, string>[],
): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  for (const ids of assertions) {
    for (const [provider, value] of Object.entries(ids)) {
      if (value === "") continue;
      const held = merged[provider];
      if (held !== undefined && held !== value) return undefined;
      merged[provider] = value;
    }
  }
  return merged;
}

export { pruneEmptiedItems } from "../db/tree.ts";

/**
 * Removes the imported Files a walk missed from these root Items'
 * subtrees. A stale File inside the scan's Item folder is confirmed
 * missing first; one outside it goes only when it is gone from its root.
 * Queued moves retain their source Files until the follow-up applies them.
 * Returns the leaf Item ids whose Files were removed, for pruning.
 */
async function reconcileStaleFiles(
  tx: Transaction,
  libraryId: string,
  source: ScanSource,
  rules: ScanRules,
  scope: string,
  itemIds: readonly string[],
  walkedKeys: ReadonlySet<string>,
  changes: readonly ScanChange[],
): Promise<string[]> {
  if (itemIds.length === 0) {
    await queuedScanMoveSources(tx, libraryId, changes);
    return [];
  }
  const held = await tx
    .select({
      id: files.id,
      versionId: files.versionId,
      itemId: files.itemId,
      rootId: files.rootId,
      path: files.path,
    })
    .from(files)
    .innerJoin(
      versions,
      and(eq(versions.id, files.versionId), eq(versions.origin, "imported")),
    )
    .innerJoin(itemAncestors, eq(itemAncestors.descendantId, files.itemId))
    .where(
      and(
        inArray(itemAncestors.ancestorId, [...itemIds]),
        eq(files.libraryId, libraryId),
      ),
    );
  // A File is stale only when its own root lacks it.
  const stale = held.filter((file) => !walkedKeys.has(rootedKey(file)));
  // Only a path inside the scope can have come back since the walk.
  await source.confirmMissing(
    stale.filter((file) => inScope(rules, scope, false, file.path)),
  );
  const missing = [];
  for (const file of stale) {
    if (inScope(rules, scope, false, file.path) || !(await source.exists(file)))
      missing.push(file);
  }
  // Enqueues do not take the Library lock. Read them after the filesystem
  // checks, just before deletion, so a move arriving during the write counts.
  const pendingMoves = await queuedScanMoveSources(tx, libraryId, changes);
  const gone = missing.filter((file) => !pendingMoves.has(rootedKey(file)));
  const goneIds = gone.map((file) => file.id);
  if (goneIds.length > 0)
    await tx.delete(files).where(inArray(files.id, goneIds));
  for (const versionId of new Set(gone.map((file) => file.versionId))) {
    const [remaining] = await tx
      .select({ id: files.id })
      .from(files)
      .where(eq(files.versionId, versionId))
      .limit(1);
    if (remaining === undefined)
      await tx.delete(versions).where(eq(versions.id, versionId));
  }
  const touched = [...new Set(gone.map((file) => file.itemId))];
  await retireEmptyLocations(tx, libraryId, touched);
  return touched;
}

/**
 * Finds the root Item one group writes to: exact folder and title key
 * first, then its tags and authoritative webhook ids, which check the ids
 * earlier groups of this scan asserted before stored ids, then the Item
 * owning the group's Files, then the title-key fallback, else a new
 * Item. A found Item moves to the group's folder and key only when the
 * group holds Files in the Item's home root.
 */
async function findGroupItem(
  tx: Transaction,
  source: ScanSource,
  positions: ReadonlyMap<string, number>,
  context: {
    libraryId: string;
    kind: "movie" | "show";
    group: {
      canonicalFolder: string;
      titleKey: string;
      title: string;
      year: number | null;
      providerIds: Record<string, string>;
      files: readonly RootedPath[];
    };
    changeProviderIds: Record<string, string>;
    /** Explicit ids earlier groups asserted, as `provider:value` to Item id. */
    sameScan?: ReadonlyMap<string, string>;
    candidates: () => Promise<Awaited<ReturnType<typeof rootItemCandidates>>>;
    claimed: Set<string>;
  },
): Promise<typeof items.$inferSelect> {
  const { libraryId, kind, group } = context;
  const [exactRow] = await tx
    .select({ item: items })
    .from(items)
    .innerJoin(itemFolders, eq(itemFolders.itemId, items.id))
    .innerJoin(libraryRoots, eq(libraryRoots.id, itemFolders.rootId))
    .where(
      and(
        eq(libraryRoots.libraryId, libraryId),
        isNull(items.parentId),
        eq(itemFolders.canonicalFolder, group.canonicalFolder),
        eq(itemFolders.titleKey, group.titleKey),
      ),
    )
    .limit(1);
  const exact = exactRow?.item;
  let found = await findItemByProviderIds(
    tx,
    kind,
    exact === undefined
      ? { ...group.providerIds, ...context.changeProviderIds }
      : context.changeProviderIds,
  );
  const authoritative = Object.values(context.changeProviderIds).some(
    (value) => value !== "",
  );
  const tagReuseAllowed = async (id: string) => {
    if (exact !== undefined && exact.id !== id) return false;
    const locations = await tx
      .select()
      .from(itemFolders)
      .where(eq(itemFolders.itemId, id));
    return !locations.some(
      (location) =>
        location.titleKey !== null &&
        group.files.some((file) => file.rootId === location.rootId) &&
        (location.canonicalFolder !== group.canonicalFolder ||
          location.titleKey !== group.titleKey),
    );
  };
  if (
    found !== undefined &&
    !authoritative &&
    !(await tagReuseAllowed(found.id))
  )
    found = undefined;
  const earlier = new Set<string>();
  for (const [provider, value] of Object.entries({
    ...group.providerIds,
    ...context.changeProviderIds,
  })) {
    const id =
      value === "" ? undefined : context.sameScan?.get(`${provider}:${value}`);
    if (id !== undefined && (authoritative || (await tagReuseAllowed(id))))
      earlier.add(id);
  }
  if (earlier.size > 1) throw new AuthError("CONFLICT");
  const [earlierId] = earlier;
  if (exact && found && exact.id !== found.id) throw new AuthError("CONFLICT");
  if (exact) {
    if (earlierId !== undefined && exact.id !== earlierId)
      throw new AuthError("CONFLICT");
    if (exact.kind !== kind) throw new AuthError("CONFLICT");
    return exact;
  }
  if (earlierId !== undefined) {
    if (found !== undefined && found.id !== earlierId)
      throw new AuthError("CONFLICT");
    // The earlier group already placed this Item during this scan.
    const [row] = await tx.select().from(items).where(eq(items.id, earlierId));
    if (row === undefined) throw new Error("Same-scan Item missing.");
    return row;
  }
  let located = found;
  if (located === undefined) {
    located =
      kind === "show"
        ? await findShowOwningFiles(tx, libraryId, group.files, source)
        : await findMovieOwningFiles(tx, libraryId, group.files);
  }
  if (located === undefined) {
    const candidate = fallbackCandidate(
      await context.candidates(),
      group,
      context.claimed,
    );
    if (candidate !== undefined) {
      const [row] = await tx
        .select()
        .from(items)
        .where(eq(items.id, candidate.id));
      located = row;
    }
  }
  if (located !== undefined) {
    if (located.kind !== kind) throw new AuthError("CONFLICT");
    context.claimed.add(located.id);
    if (await coversHomeRoot(tx, positions, source, located.id, group.files)) {
      // Colocated artwork keys carry the folder, so they move with it.
      await updateItemCanonicalFolder(
        tx,
        located,
        group.canonicalFolder,
        group.titleKey,
        group.files.map((file) => file.rootId),
      );
    }
    return located;
  }
  return insertItem(tx, {
    kind,
    title: group.title,
    year: group.year,
    extension: {},
  });
}

/** One structured timing line per directory scan, in the server's JSON log shape. */
function logScanTiming(
  data: Record<string, unknown> & { libraryId: string; path: string },
) {
  console.log(
    JSON.stringify({
      ...data,
      timestamp: new Date().toISOString(),
      level: "info",
      message: "scan.directory",
    }),
  );
}

/** Probe each member once, retaining failed paths as present for reconciliation. */
async function probeScanMembers(
  db: Database,
  libraryId: string,
  source: ScanSource,
  walked: readonly RootedFile[],
  members: readonly RootedPath[],
) {
  const previous = await db
    .select({ failure: scanFailures })
    .from(scanFailures)
    .innerJoin(libraryRoots, eq(libraryRoots.id, scanFailures.rootId))
    .where(eq(libraryRoots.libraryId, libraryId));
  const failures = new Map(
    previous.map(({ failure }) => [rootedKey(failure), failure]),
  );
  const walkedByKey = new Map(walked.map((file) => [rootedKey(file), file]));
  const memberByKey = new Map<string, ProbedRootedFile>();
  const skipped = new Map<string, RootedFile>();
  const freshFailures: (typeof scanFailures.$inferInsert)[] = [];
  let probed = 0;
  for (const file of members) {
    const key = rootedKey(file);
    if (memberByKey.has(key) || skipped.has(key)) continue;
    const snapshot = walkedByKey.get(key);
    if (!snapshot) throw new Error(`Unwalked member: ${file.path}`);
    const previous = failures.get(key);
    if (
      previous?.bytes === snapshot.bytes &&
      previous.modifiedNs === snapshot.modifiedNs
    ) {
      skipped.set(key, snapshot);
      continue;
    }
    let member: ProbedRootedFile;
    try {
      member = await source.probe(file);
    } catch (error) {
      if (!(error instanceof UnreadableMediaError)) throw error;
      skipped.set(key, snapshot);
      freshFailures.push({
        ...file,
        bytes: snapshot.bytes,
        modifiedNs: snapshot.modifiedNs,
        reason: "unreadable",
        detail: error.message,
      });
      continue;
    }
    if (
      !member.probe.streams.some(
        (stream) => stream.kind === "video" && !stream.disposition.attached_pic,
      )
    ) {
      skipped.set(key, { ...snapshot, ...member });
      freshFailures.push({
        ...file,
        bytes: member.bytes,
        modifiedNs: member.modifiedNs,
        reason: "no-video",
        detail: `Recognized media has no video stream: ${file.path}`,
      });
      continue;
    }
    if (!member.cached) probed += 1;
    memberByKey.set(key, member);
  }
  return { memberByKey, skipped, freshFailures, previous, probed };
}

/** Commit new failures and remove recovered or vanished paths after a successful scan. */
async function persistScanFailures(
  tx: Transaction,
  rules: ScanRules,
  path: string,
  walked: readonly RootedFile[],
  result: Awaited<ReturnType<typeof probeScanMembers>>,
) {
  const walkedKeys = new Set(walked.map(rootedKey));
  const removed = result.previous
    .filter(
      ({ failure }) =>
        result.memberByKey.has(rootedKey(failure)) ||
        (inScope(rules, path, false, failure.path) &&
          !walkedKeys.has(rootedKey(failure))),
    )
    .map(({ failure }) => failure.id);
  if (removed.length > 0)
    await tx.delete(scanFailures).where(inArray(scanFailures.id, removed));
  for (const failure of result.freshFailures)
    await tx
      .insert(scanFailures)
      .values(failure)
      .onConflictDoUpdate({
        target: [scanFailures.rootId, scanFailures.path],
        set: {
          bytes: failure.bytes,
          modifiedNs: failure.modifiedNs,
          reason: failure.reason,
          detail: failure.detail,
          failedAt: new Date(),
        },
      });
}

/** A failed file is still present, even when a queued delete names it or its folder. */
function changesWithoutFailedDeletes(
  changes: readonly ScanChange[],
  skipped: ReadonlyMap<string, RootedFile>,
) {
  return changes.filter((change) => {
    if (change.kind !== "delete") return true;
    if (change.target === "file") return !skipped.has(rootedKey(change));
    return ![...skipped.values()].some(
      (file) =>
        file.rootId === change.rootId &&
        (change.path === "." || file.path.startsWith(`${change.path}/`)),
    );
  });
}

/**
 * Scan one Item folder of a movies library into Items, Versions, Files
 * and Streams. `itemId` is the first written Item, as before.
 */
export async function scanDirectory(
  db: Database,
  libraryId: string,
  path: string,
  options: ScanDirectoryOptions = {},
): Promise<{
  itemId: string | null;
  itemIds: string[];
  versionIds: string[];
  probed: number;
}> {
  const startedAt = performance.now();
  const changes = options.changes ?? [];
  const [library] = await db
    .select()
    .from(libraries)
    .where(eq(libraries.id, libraryId));
  if (!library) throw new AuthError("NOT_FOUND");
  if (library.medium !== "movies") throw new AuthError("INVALID_INPUT");
  const source =
    options.source ?? (await libraryScanSource(db, library, options.probe));
  const { rules } = scanScope("movies");

  // Grouping reads root-relative paths, so the same folder in two roots is
  // one Item; each root's file at a member path is its own Version.
  const walked = await source.walk(path, false);
  const walkedAt = performance.now();
  const discovered = groupMoviePaths(walked).filter(
    (group) => group.canonicalFolder === path,
  );
  const result = await probeScanMembers(
    db,
    libraryId,
    source,
    walked,
    discovered.flatMap((group) => group.files),
  );
  const { memberByKey, skipped, probed } = result;
  const walkedKeys = new Set(walked.map(rootedKey));
  // A move's assertion names the path the walk saw, so fold each chain's ids
  // to its surviving destination before matching groups. A destination the
  // walk never saw asserts nothing; it waits for a later read.
  const providerChanges = scanAssertions(changes).filter((change) =>
    walkedKeys.has(rootedKey(change)),
  );
  const groups = discovered
    .map((group) => ({
      ...group,
      files: group.files.filter((file) => memberByKey.has(rootedKey(file))),
    }))
    .filter((group) => group.files.length > 0);

  const probedAt = performance.now();

  // Artwork of deleted Items is removed only after the delete commits.
  const deletedArtwork: DeletedArtworkFile[] = [];
  const written = await db.transaction(async (tx) => {
    await lockCatalogue(tx);
    const [locked] = await tx
      .select()
      .from(libraries)
      .where(eq(libraries.id, libraryId))
      .for("update");
    if (!locked) throw new AuthError("NOT_FOUND");
    // A root edit between the walk and this lock made the snapshot stale.
    if (locked.rootsRevision !== source.rootsRevision)
      throw new Error("Library roots changed before scan write.");

    const emptiedItemIds = await applyScanChanges(
      tx,
      libraryId,
      changesWithoutFailedDeletes(changes, skipped),
      deletedArtwork,
    );

    for (const member of memberByKey.values()) await source.verify(member);
    for (const file of skipped.values()) await source.verify(file);

    const itemIds: string[] = [];
    const foreignItemIds: string[] = [];
    const versionIds: string[] = [];
    const positions = new Map(
      (await rootsOf(tx, libraryId)).map((root, index) => [root.id, index]),
    );
    const claimed = new Set<string>();
    let candidates: Awaited<ReturnType<typeof rootItemCandidates>> | undefined;
    const singleGroup = discovered.length === 1;

    const asserted = new Map<string, string>();
    const resolved = [];
    for (const group of groups) {
      // Webhooks override tags; both can reuse a server Item in a different root.
      const webhookProviderIds = groupChangeProviderIds(
        providerChanges,
        group.files,
        singleGroup,
      );
      const item = await findGroupItem(tx, source, positions, {
        libraryId,
        kind: "movie",
        group,
        changeProviderIds: webhookProviderIds,
        sameScan: asserted,
        candidates: async () =>
          (candidates ??= await rootItemCandidates(tx, libraryId, "movie")),
        claimed,
      });
      for (const rootId of new Set(group.files.map((file) => file.rootId))) {
        const location = await itemLocation(tx, item.id, rootId);
        if (location === undefined || location.titleKey === null)
          await setItemLocation(
            tx,
            item.id,
            rootId,
            group.canonicalFolder,
            group.titleKey,
          );
      }
      itemIds.push(item.id);
      resolved.push({ group, itemId: item.id, webhookProviderIds });
      for (const [provider, value] of Object.entries({
        ...group.providerIds,
        ...webhookProviderIds,
      })) {
        if (value !== "") asserted.set(`${provider}:${value}`, item.id);
      }
    }
    const timelineOwners = new Set<string>();

    for (const { group, itemId } of resolved) {
      for (const named of group.files) {
        const member = memberByKey.get(rootedKey(named));
        if (!member) throw new Error(`Unprobed member: ${named.path}`);
        const label = videoVersionLabel(member.path, member.probe);
        const [existingFile] = await tx
          .select()
          .from(files)
          .where(
            and(eq(files.rootId, member.rootId), eq(files.path, member.path)),
          );

        let versionId: string;
        let fileId: string;
        // A File another movie Item of this Library owns stays with its
        // Item: it is refreshed in place, never regrouped.
        if (existingFile && existingFile.itemId !== itemId) {
          const [owner] = await tx
            .select({ kind: items.kind })
            .from(items)
            .where(eq(items.id, existingFile.itemId));
          if (existingFile.libraryId !== libraryId || owner?.kind !== "movie") {
            throw new AuthError("CONFLICT");
          }
          foreignItemIds.push(existingFile.itemId);
          timelineOwners.add(existingFile.itemId);
        }
        if (existingFile) {
          versionId = existingFile.versionId;
          fileId = existingFile.id;
          await tx
            .update(versions)
            .set({
              label,
              bytes: member.bytes,
              durationSeconds: member.probe.durationSeconds,
              ...(await versionIndexState(tx, member)),
            })
            .where(eq(versions.id, versionId));
          await tx
            .update(files)
            .set({
              bytes: member.bytes,
              modifiedAt: member.modifiedAt,
              container: member.probe.container,
              durationSeconds: member.probe.durationSeconds,
              chapters: member.probe.chapters,
            })
            .where(eq(files.id, fileId));
        } else {
          const [version] = await tx
            .insert(versions)
            .values({
              itemId,
              itemKind: "movie",
              libraryId,
              label,
              format: "video",
              bytes: member.bytes,
              durationSeconds: member.probe.durationSeconds,
              ...(await versionIndexState(tx, member)),
            })
            .returning();
          if (!version) {
            throw new Error("Version insertion returned no row.");
          }
          const [file] = await tx
            .insert(files)
            .values({
              versionId: version.id,
              itemId,
              libraryId,
              rootId: member.rootId,
              path: member.path,
              order: 0,
              bytes: member.bytes,
              modifiedAt: member.modifiedAt,
              container: member.probe.container,
              durationSeconds: member.probe.durationSeconds,
              chapters: member.probe.chapters,
            })
            .returning();
          if (!file) {
            throw new Error("File insertion returned no row.");
          }
          versionId = version.id;
          fileId = file.id;
        }
        versionIds.push(versionId);
        await upsertFileStreams(tx, versionId, fileId, member.probe);
        // The keyframe index arrives from its own job after the scan.
        if ((await versionIndexState(tx, member)).lazyIndexPending)
          await queueKeyframeIndex(tx, {
            libraryId,
            rootId: member.rootId,
            path: member.path,
          });
      }

      timelineOwners.add(itemId);
    }

    // A changed provider id invalidates the match, so metadata re-fetches.
    // Webhook ids assert; folder tags only fill ids nothing asserted yet.
    // An Item's groups merge their ids. Groups that give one provider two
    // values write none of that kind, so a legacy Item holding several
    // movies keeps its match. A lone asserting group still applies, because
    // webhook ids are authoritative.
    for (const [itemId, owned] of Map.groupBy(
      resolved,
      (entry) => entry.itemId,
    )) {
      const webhook = mergeProviderIds(
        owned.map((entry) => entry.webhookProviderIds),
      );
      const tagged = mergeProviderIds(
        owned.map((entry) => entry.group.providerIds),
      );
      const assertedChanged =
        webhook !== undefined &&
        (await setItemProviderIds(tx, itemId, webhook));
      const filledChanged =
        tagged !== undefined &&
        (await setItemProviderIds(tx, itemId, tagged, { fillOnly: true }));
      if (assertedChanged || filledChanged)
        await tx
          .update(items)
          .set({ metadataState: "pending", updatedAt: new Date() })
          .where(eq(items.id, itemId));
    }
    for (const owner of timelineOwners) await persistScanTimelines(tx, owner);

    await retireEmptyLocations(tx, libraryId, emptiedItemIds);
    await pruneEmptiedItems(tx, emptiedItemIds, deletedArtwork);

    if (options.reconcileMissing === true) {
      if (walked.length === 0) await source.confirmEmpty(path, false);
      const atFolder = await tx
        .select({ id: items.id })
        .from(items)
        .where(
          and(
            inLibraries([libraryId]),
            eq(items.kind, "movie"),
            isNull(items.parentId),
            sql`exists (select 1 from item_folders location join library_roots root on root.id = location.root_id where location.item_id = ${items.id} and location.canonical_folder = ${path} and root.library_id = ${libraryId})`,
          ),
        );
      const touched = await reconcileStaleFiles(
        tx,
        libraryId,
        source,
        rules,
        path,
        [...new Set([...itemIds, ...atFolder.map((row) => row.id)])],
        walkedKeys,
        changes,
      );
      await pruneEmptiedItems(tx, touched, deletedArtwork);
    } else {
      await queuedScanMoveSources(tx, libraryId, changes);
    }

    await persistScanFailures(tx, rules, path, walked, result);
    return {
      itemIds: [...new Set([...itemIds, ...foreignItemIds])],
      versionIds,
    };
  });
  const writtenAt = performance.now();
  await removeArtworkFiles(deletedArtwork);
  logScanTiming({
    libraryId,
    path,
    files: memberByKey.size,
    probeCacheHits: memberByKey.size - probed,
    walkMs: Math.round(walkedAt - startedAt),
    probeMs: Math.round(probedAt - walkedAt),
    writeMs: Math.round(writtenAt - probedAt),
  });
  return { itemId: written.itemIds[0] ?? null, ...written, probed };
}

/**
 * Scan one Item folder of a shows library into Show, Season and Episode
 * Items with episode Versions. `itemId` is the first written Show, as before.
 */
export async function scanShowDirectory(
  db: Database,
  libraryId: string,
  path: string,
  options: ScanDirectoryOptions = {},
): Promise<{
  itemId: string | null;
  itemIds: string[];
  versionIds: string[];
  probed: number;
}> {
  const startedAt = performance.now();
  const changes = options.changes ?? [];
  const [library] = await db
    .select()
    .from(libraries)
    .where(eq(libraries.id, libraryId));
  if (!library) throw new AuthError("NOT_FOUND");
  if (library.medium !== "shows") throw new AuthError("INVALID_INPUT");
  const source =
    options.source ?? (await libraryScanSource(db, library, options.probe));
  const { rules } = scanScope("shows");

  const walked = await source.walk(path, false);
  const walkedAt = performance.now();
  const discovered = groupShowPaths(walked).filter(
    (candidate) => candidate.canonicalFolder === path,
  );
  const walkedKeys = new Set(walked.map(rootedKey));
  // A move's assertion names the path the walk saw, so fold each chain's ids
  // to its surviving destination before matching groups. A destination the
  // walk never saw asserts nothing; it waits for a later read.
  const providerChanges = scanAssertions(changes).filter((change) =>
    walkedKeys.has(rootedKey(change)),
  );

  const result = await probeScanMembers(
    db,
    libraryId,
    source,
    walked,
    discovered.flatMap((group) =>
      group.seasons.flatMap((season) =>
        season.episodes.flatMap((episode) =>
          episode.versions.flatMap((version) =>
            version.paths.map((path) => ({ rootId: version.rootId, path })),
          ),
        ),
      ),
    ),
  );
  const { memberByKey, skipped, probed } = result;
  // A split Version plays only when every part is readable. Keep the full walk
  // for reconciliation, including good parts of Versions skipped as a whole.
  const groups = discovered
    .map((group) => ({
      ...group,
      seasons: group.seasons
        .map((season) => ({
          ...season,
          episodes: season.episodes
            .map((episode) => ({
              ...episode,
              versions: episode.versions.filter((version) =>
                version.paths.every((path) =>
                  memberByKey.has(rootedKey({ rootId: version.rootId, path })),
                ),
              ),
            }))
            .filter((episode) => episode.versions.length > 0),
        }))
        .filter((season) => season.episodes.length > 0),
    }))
    .filter((group) => group.seasons.length > 0);

  const probedAt = performance.now();

  // Artwork of deleted Items is removed only after the delete commits.
  const deletedArtwork: DeletedArtworkFile[] = [];
  const written = await db.transaction(async (tx) => {
    await lockCatalogue(tx);
    const [locked] = await tx
      .select()
      .from(libraries)
      .where(eq(libraries.id, libraryId))
      .for("update");
    if (!locked) throw new AuthError("NOT_FOUND");
    // A root edit between the walk and this lock made the snapshot stale.
    if (locked.rootsRevision !== source.rootsRevision)
      throw new Error("Library roots changed before scan write.");

    const emptiedItemIds = await applyScanChanges(
      tx,
      libraryId,
      changesWithoutFailedDeletes(changes, skipped),
      deletedArtwork,
    );

    for (const member of memberByKey.values()) await source.verify(member);
    for (const file of skipped.values()) await source.verify(file);

    const itemIds: string[] = [];
    const versionIds: string[] = [];
    const positions = new Map(
      (await rootsOf(tx, libraryId)).map((root, index) => [root.id, index]),
    );
    const claimed = new Set<string>();
    let candidates: Awaited<ReturnType<typeof rootItemCandidates>> | undefined;
    const singleGroup = discovered.length === 1;
    const asserted = new Map<string, string>();

    for (const group of groups) {
      const groupFiles = group.seasons.flatMap((season) =>
        season.episodes.flatMap((episode) =>
          episode.versions.flatMap((version) =>
            version.paths.map((memberPath) => ({
              rootId: version.rootId,
              path: memberPath,
            })),
          ),
        ),
      );
      const webhookProviderIds = groupChangeProviderIds(
        providerChanges,
        groupFiles,
        singleGroup,
      );
      const show = await findGroupItem(tx, source, positions, {
        libraryId,
        kind: "show",
        group: { ...group, files: groupFiles },
        changeProviderIds: webhookProviderIds,
        sameScan: asserted,
        candidates: async () =>
          (candidates ??= await rootItemCandidates(tx, libraryId, "show")),
        claimed,
      });
      const showId = show.id;
      for (const [provider, value] of Object.entries({
        ...group.providerIds,
        ...webhookProviderIds,
      }))
        if (value !== "") asserted.set(`${provider}:${value}`, showId);
      for (const rootId of new Set(groupFiles.map((file) => file.rootId))) {
        const location = await itemLocation(tx, showId, rootId);
        if (location === undefined || location.titleKey === null)
          await setItemLocation(
            tx,
            showId,
            rootId,
            group.canonicalFolder,
            group.titleKey,
          );
      }
      itemIds.push(showId);

      const claimedSeasons = new Set<string>();
      for (const seasonGroup of group.seasons) {
        const seasonFiles = seasonGroup.episodes.flatMap((episode) =>
          episode.versions.flatMap((version) =>
            version.paths.map((memberPath) => ({
              rootId: version.rootId,
              path: memberPath,
            })),
          ),
        );
        // Existing Files retain their Season lineage when an editor changes its display number.
        const owningSeasons = await tx
          .selectDistinct({ id: seasons.itemId })
          .from(files)
          .innerJoin(episodes, eq(episodes.itemId, files.itemId))
          .innerJoin(seasons, eq(seasons.itemId, episodes.seasonId))
          .where(and(eq(seasons.showId, showId), rootedPairs(seasonFiles)));
        if (owningSeasons.length > 1) throw new AuthError("CONFLICT");
        const owner = owningSeasons[0];
        const [existingSeason] = await tx
          .select({ item: items, season: seasons })
          .from(seasons)
          .innerJoin(items, eq(items.id, seasons.itemId))
          .where(
            and(
              eq(seasons.showId, showId),
              owner === undefined
                ? eq(seasons.seasonNumber, seasonGroup.seasonNumber)
                : eq(seasons.itemId, owner.id),
            ),
          );
        let seasonId: string;
        if (existingSeason) {
          if (
            existingSeason.item.parentId !== showId ||
            existingSeason.item.kind !== "season"
          ) {
            throw new AuthError("CONFLICT");
          }
          seasonId = existingSeason.item.id;
        } else {
          const created = await insertItem(tx, {
            kind: "season",
            parentId: showId,
            title: seasonGroup.title,
            extension: { seasonNumber: seasonGroup.seasonNumber },
          });
          seasonId = created.id;
        }

        for (const rootId of new Set(seasonFiles.map((file) => file.rootId)))
          await setItemLocation(
            tx,
            seasonId,
            rootId,
            seasonGroup.canonicalFolder,
            null,
          );

        // An edited display number must not make two filename Seasons share Episodes and progress.
        if (claimedSeasons.has(seasonId)) throw new AuthError("CONFLICT");
        claimedSeasons.add(seasonId);

        const persistedEpisodes = await tx
          .select({
            itemId: episodes.itemId,
            episodeNumber: episodes.episodeNumber,
            episodeEndNumber: episodes.episodeEndNumber,
          })
          .from(episodes)
          .where(eq(episodes.seasonId, seasonId));

        const owners = await tx
          .select({ path: files.path, episodeNumber: episodes.episodeNumber })
          .from(files)
          .innerJoin(episodes, eq(episodes.itemId, files.itemId))
          .where(
            and(eq(episodes.seasonId, seasonId), rootedPairs(seasonFiles)),
          );
        const seasonEpisodes = mergeEpisodeRanges(
          seasonGroup.episodes,
          persistedEpisodes.map((persisted) => persisted.episodeNumber),
          new Map(owners.map((owner) => [owner.path, owner.episodeNumber])),
        );

        const discoveredStarts = seasonEpisodes.map(
          (episode) => episode.episodeNumber,
        );
        for (const persisted of persistedEpisodes) {
          const persistedEnd =
            persisted.episodeEndNumber ?? persisted.episodeNumber;
          const blockingStart = discoveredStarts.find(
            (start) => start > persisted.episodeNumber && start <= persistedEnd,
          );
          if (blockingStart === undefined) continue;
          const normalizedEnd = blockingStart - 1;
          await tx
            .update(episodes)
            .set({
              episodeEndNumber:
                normalizedEnd === persisted.episodeNumber
                  ? null
                  : normalizedEnd,
            })
            .where(eq(episodes.itemId, persisted.itemId));
        }

        for (const episodeGroup of seasonEpisodes) {
          const [existingEpisode] = await tx
            .select({ item: items, episode: episodes })
            .from(episodes)
            .innerJoin(items, eq(items.id, episodes.itemId))
            .where(
              and(
                eq(episodes.seasonId, seasonId),
                eq(episodes.episodeNumber, episodeGroup.episodeNumber),
              ),
            );
          let episodeId: string;
          if (existingEpisode) {
            if (
              existingEpisode.item.parentId !== seasonId ||
              existingEpisode.item.kind !== "episode"
            ) {
              throw new AuthError("CONFLICT");
            }
            episodeId = existingEpisode.item.id;
            // Merged ranges stop before every later start, so widening is safe.
            const existingEnd =
              existingEpisode.episode.episodeEndNumber ??
              existingEpisode.episode.episodeNumber;
            const discoveredEnd =
              episodeGroup.episodeEndNumber ?? episodeGroup.episodeNumber;
            if (discoveredEnd > existingEnd) {
              await tx
                .update(episodes)
                .set({ episodeEndNumber: episodeGroup.episodeEndNumber })
                .where(eq(episodes.itemId, episodeId));
            }
          } else {
            const created = await insertItem(tx, {
              kind: "episode",
              parentId: seasonId,
              title: episodeGroup.title,
              extension: {
                episodeNumber: episodeGroup.episodeNumber,
                episodeEndNumber: episodeGroup.episodeEndNumber,
              },
            });
            episodeId = created.id;
          }

          for (const rootId of new Set(
            episodeGroup.versions.map((version) => version.rootId),
          ))
            await setItemLocation(
              tx,
              episodeId,
              rootId,
              seasonGroup.canonicalFolder,
              null,
            );
          for (const versionGroup of episodeGroup.versions) {
            const { rootId } = versionGroup;
            const members = versionGroup.paths.map((memberPath) => {
              const member = memberByKey.get(
                rootedKey({ rootId, path: memberPath }),
              );
              if (!member) throw new Error(`Unprobed member: ${memberPath}`);
              return member;
            });
            const bytes = members.reduce(
              (total, member) => total + member.bytes,
              0n,
            );
            const durationSeconds = members.every(
              (member) => member.probe.durationSeconds !== null,
            )
              ? members.reduce(
                  (total, member) =>
                    total + (member.probe.durationSeconds ?? 0),
                  0,
                )
              : null;
            const first = members[0];
            if (!first) throw new Error("Show Version has no Files.");
            const label = videoVersionLabel(first.path, first.probe);
            // Each split File has its own index, so only a lone File indexes
            // the Version. The cache re-read keeps an index that landed
            // between this scan's probe and its write.
            const indexFor = async (fileCount: number) => {
              if (fileCount !== 1)
                return { keyframesSeconds: null, lazyIndexPending: false };
              return versionIndexState(tx, first);
            };

            const existingFiles = await tx
              .select()
              .from(files)
              .where(
                and(
                  eq(files.rootId, rootId),
                  inArray(files.path, versionGroup.paths),
                ),
              );
            const existingFile = existingFiles[0];
            let versionId: string;
            let versionFiles: (RootedPath & { id: string; order: number })[] =
              [];
            let retained = 0;
            if (existingFile) {
              for (const file of existingFiles) {
                if (
                  file.itemId !== episodeId ||
                  file.versionId !== existingFile.versionId
                ) {
                  throw new AuthError("CONFLICT");
                }
              }
              const [version] = await tx
                .select()
                .from(versions)
                .where(eq(versions.id, existingFile.versionId));
              if (
                !version ||
                version.itemId !== episodeId ||
                version.itemKind !== "episode" ||
                version.libraryId !== libraryId
              ) {
                throw new AuthError("CONFLICT");
              }
              versionId = version.id;
              versionFiles = await tx
                .select({
                  id: files.id,
                  rootId: files.rootId,
                  path: files.path,
                  order: files.order,
                })
                .from(files)
                .where(eq(files.versionId, versionId));
              // Reconciliation deletes only Files the walk missed; the rest stay.
              retained = versionFiles.filter(
                (file) =>
                  !versionGroup.paths.includes(file.path) &&
                  (options.reconcileMissing !== true ||
                    walkedKeys.has(rootedKey(file))),
              ).length;
              await tx
                .update(versions)
                .set({
                  label,
                  bytes,
                  durationSeconds,
                  ...(await indexFor(members.length + retained)),
                })
                .where(eq(versions.id, versionId));
            } else {
              const [version] = await tx
                .insert(versions)
                .values({
                  itemId: episodeId,
                  itemKind: "episode",
                  libraryId,
                  label,
                  format: "video",
                  bytes,
                  durationSeconds,
                  ...(await indexFor(members.length)),
                })
                .returning();
              if (!version) {
                throw new Error("Version insertion returned no row.");
              }
              versionId = version.id;
            }
            versionIds.push(versionId);
            if (
              members.length + retained === 1 &&
              (await indexFor(members.length + retained)).lazyIndexPending
            )
              await queueKeyframeIndex(tx, {
                libraryId,
                rootId: first.rootId,
                path: first.path,
              });

            const maxOrder = versionFiles.reduce(
              (maximum, file) => Math.max(maximum, file.order),
              -1,
            );
            if (maxOrder >= 0) {
              const offset = maxOrder + members.length + 1;
              await tx
                .update(files)
                .set({ order: sql`${files.order} + ${offset}` })
                .where(eq(files.versionId, versionId));
            }

            for (const [order, member] of members.entries()) {
              const file = existingFiles.find(
                (candidate) => candidate.path === member.path,
              );
              let fileId: string;
              if (file) {
                fileId = file.id;
                await tx
                  .update(files)
                  .set({
                    order,
                    bytes: member.bytes,
                    modifiedAt: member.modifiedAt,
                    container: member.probe.container,
                    durationSeconds: member.probe.durationSeconds,
                    chapters: member.probe.chapters,
                  })
                  .where(eq(files.id, fileId));
              } else {
                const [created] = await tx
                  .insert(files)
                  .values({
                    versionId,
                    itemId: episodeId,
                    libraryId,
                    rootId,
                    path: member.path,
                    order,
                    bytes: member.bytes,
                    modifiedAt: member.modifiedAt,
                    container: member.probe.container,
                    durationSeconds: member.probe.durationSeconds,
                    chapters: member.probe.chapters,
                  })
                  .returning();
                if (!created) {
                  throw new Error("File insertion returned no row.");
                }
                fileId = created.id;
              }
              await upsertFileStreams(tx, versionId, fileId, member.probe);
            }

            const memberPaths = new Set(versionGroup.paths);
            const staleFiles = versionFiles
              .filter((file) => !memberPaths.has(file.path))
              .sort(
                (a, b) =>
                  a.order - b.order ||
                  a.path.localeCompare(b.path) ||
                  a.id.localeCompare(b.id),
              );
            for (const [index, file] of staleFiles.entries()) {
              await tx
                .update(files)
                .set({ order: members.length + index })
                .where(eq(files.id, file.id));
            }
          }
        }
      }

      // A changed provider id invalidates the match, so metadata re-fetches.
      // Webhook ids assert; folder tags only fill ids nothing asserted yet.
      const assertedChanged = await setItemProviderIds(
        tx,
        showId,
        webhookProviderIds,
      );
      const filledChanged = await setItemProviderIds(
        tx,
        showId,
        group.providerIds,
        { fillOnly: true },
      );
      if (assertedChanged || filledChanged) {
        await tx
          .update(items)
          .set({ metadataState: "pending", updatedAt: new Date() })
          .where(eq(items.id, showId));
      }
    }

    await retireEmptyLocations(tx, libraryId, emptiedItemIds);
    await pruneEmptiedItems(tx, emptiedItemIds, deletedArtwork);

    if (options.reconcileMissing === true) {
      if (walked.length === 0) await source.confirmEmpty(path, false);
      const atFolder = await tx
        .select({ id: items.id })
        .from(items)
        .where(
          and(
            inLibraries([libraryId]),
            eq(items.kind, "show"),
            isNull(items.parentId),
            sql`exists (select 1 from item_folders location join library_roots root on root.id = location.root_id where location.item_id = ${items.id} and location.canonical_folder = ${path} and root.library_id = ${libraryId})`,
          ),
        );
      const touched = await reconcileStaleFiles(
        tx,
        libraryId,
        source,
        rules,
        path,
        [...new Set([...itemIds, ...atFolder.map((row) => row.id)])],
        walkedKeys,
        changes,
      );
      await pruneEmptiedItems(tx, touched, deletedArtwork);
    } else {
      await queuedScanMoveSources(tx, libraryId, changes);
    }

    await persistScanFailures(tx, rules, path, walked, result);
    return { itemIds: [...new Set(itemIds)], versionIds };
  });
  const writtenAt = performance.now();
  await removeArtworkFiles(deletedArtwork);
  logScanTiming({
    libraryId,
    path,
    files: memberByKey.size,
    probeCacheHits: memberByKey.size - probed,
    walkMs: Math.round(walkedAt - startedAt),
    probeMs: Math.round(probedAt - walkedAt),
    writeMs: Math.round(writtenAt - probedAt),
  });
  return { itemId: written.itemIds[0] ?? null, ...written, probed };
}
