import { resolve } from "node:path";
import { asc, eq } from "drizzle-orm";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import { itemFolders, libraryRoots } from "../db/schema/index.ts";
import { homeLocation } from "./membership.ts";
import { type LibraryFile, readLibraryFile } from "./walker.ts";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Connection = Database | Transaction;

/** One root of a Library: its id and absolute path. */
export type LibraryRoot = Pick<typeof libraryRoots.$inferSelect, "id" | "path">;

/** A root-relative path in one root of a Library. */
export type RootedPath = { rootId: string; path: string };

/** One key per file across a Library's roots. */
export const rootedKey = (file: RootedPath) => `${file.rootId}:${file.path}`;

const rootFields = { id: libraryRoots.id, path: libraryRoots.path };

/** Lists a Library's roots, first root first. */
export function rootsOf(db: Connection, libraryId: string) {
  return db
    .select(rootFields)
    .from(libraryRoots)
    .where(eq(libraryRoots.libraryId, libraryId))
    .orderBy(asc(libraryRoots.position), asc(libraryRoots.id));
}

/** Reads one root's absolute path. */
export async function rootPath(db: Connection, rootId: string) {
  const [root] = await db
    .select({ path: libraryRoots.path })
    .from(libraryRoots)
    .where(eq(libraryRoots.id, rootId));
  if (root === undefined) throw new AuthError("NOT_FOUND");
  return root.path;
}

/** Joins a root-relative path to its root without touching the disk, for folders that may not exist yet. */
export async function absolutePath(
  db: Connection,
  at: { rootId: string; path: string },
) {
  return resolve(await rootPath(db, at.rootId), at.path);
}

/**
 * Stats a file under a root's absolute path without following links and
 * returns it with its absolute path. Throws `MissingLibraryPathError` when
 * it is gone.
 */
export async function locateIn(
  root: string,
  path: string,
): Promise<LibraryFile & { absolute: string }> {
  const found = await readLibraryFile(root, path);
  return { ...found, absolute: resolve(root, found.path) };
}

/** Locates a File, or any root-relative path, in its root; see `locateIn`. */
export async function locateFile(
  db: Connection,
  file: { rootId: string; path: string },
) {
  return locateIn(await rootPath(db, file.rootId), file.path);
}

/** Current write location, selected by import age and then root order. */
export async function homeRoot(db: Connection, itemId: string) {
  const home = await homeLocation(db, itemId);
  if (home === undefined) throw new AuthError("NOT_FOUND");
  return { ...home, id: home.rootId };
}

/** Asset locations retain their own folders so home changes do not strand existing originals. */
export async function assetRoots(db: Connection, itemId: string) {
  const locations = await db
    .select({
      id: libraryRoots.id,
      path: libraryRoots.path,
      canonicalFolder: itemFolders.canonicalFolder,
    })
    .from(itemFolders)
    .innerJoin(libraryRoots, eq(libraryRoots.id, itemFolders.rootId))
    .where(eq(itemFolders.itemId, itemId))
    .orderBy(asc(libraryRoots.position), asc(libraryRoots.id));
  const home = await homeLocation(db, itemId);
  return locations.sort(
    (a, b) => Number(b.id === home?.rootId) - Number(a.id === home?.rootId),
  );
}

/**
 * The first non-null answer across candidates, treating a throw as "not
 * here". If every candidate threw, the first error is rethrown.
 */
export async function firstInRoots<Candidate, Found>(
  candidates: readonly Candidate[],
  attempt: (candidate: Candidate) => Promise<Found | null>,
): Promise<Found | null> {
  let firstError: unknown;
  let answered = false;
  for (const candidate of candidates) {
    try {
      const found = await attempt(candidate);
      answered = true;
      if (found !== null) return found;
    } catch (error) {
      firstError ??= error;
    }
  }
  if (!answered && firstError !== undefined) throw firstError;
  return null;
}
