import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { server } from "../auth/access.ts";
import { AuthError } from "../auth/errors.ts";
import { permittedVersionIds, requirePermission } from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import type { JsonObject } from "../db/schema/common.ts";
import {
  files,
  items,
  jobs,
  libraries,
  settings,
  versions,
} from "../db/schema/index.ts";
import { homeLibraryId } from "../libraries/membership.ts";
import {
  type IdleWindow,
  idleWindowAt,
  readStoredVersionPolicy,
  rungFits,
  type StoredVersionPolicy,
} from "./policy.ts";
import {
  bestSources,
  reconcileStoredVersions,
  requestStore,
} from "./reconcile.ts";

async function loadLibrary(db: Database, id: string) {
  const [library] = await db
    .select()
    .from(libraries)
    .where(eq(libraries.id, id))
    .limit(1);
  if (library === undefined) throw new AuthError("NOT_FOUND");
  return library;
}

/** Reads a library's stored-version policy for a caller holding transcoding:manage. */
export async function getStoredVersionPolicy(
  db: Database,
  actorId: string,
  libraryId: string,
) {
  await requirePermission(db, actorId, "transcoding:manage", server);
  const library = await loadLibrary(db, libraryId);
  return { policy: readStoredVersionPolicy(library.configuration) };
}

/** Replaces a library's stored-version policy, null to store nothing, then reconciles the library. */
export async function setStoredVersionPolicy(
  db: Database,
  actorId: string,
  libraryId: string,
  policy: StoredVersionPolicy | null,
) {
  await requirePermission(db, actorId, "transcoding:manage", server);
  // The row lock keeps a concurrent configuration write from being lost.
  const library = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(libraries)
      .where(eq(libraries.id, libraryId))
      .for("update");
    if (current === undefined) throw new AuthError("NOT_FOUND");
    const { storedVersions: _previous, ...rest } = current.configuration;
    // A JSON round trip turns the decoded readonly policy into plain JSON.
    const storedVersions: JsonObject = JSON.parse(JSON.stringify(policy));
    const configuration = policy === null ? rest : { ...rest, storedVersions };
    const [updated] = await tx
      .update(libraries)
      .set({ configuration })
      .where(eq(libraries.id, libraryId))
      .returning();
    if (updated === undefined) throw new AuthError("NOT_FOUND");
    return updated;
  });
  await reconcileStoredVersions(db, library);
  return { policy: readStoredVersionPolicy(library.configuration) };
}

/** Sets the server-wide idle window for a caller holding server:manage, and books waiting store jobs into the new window. */
export async function setIdleWindow(
  db: Database,
  actorId: string,
  idleWindow: IdleWindow,
  now = new Date(),
) {
  await requirePermission(db, actorId, "server:manage", server);
  const place = idleWindowAt(idleWindow, now);
  const runAfter = place.inside ? now : place.startsAt;
  const value = { idleWindow };
  await db.transaction(async (tx) => {
    await tx
      .insert(settings)
      .values({ key: "store", value })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: sql`clock_timestamp()` },
      });
    // A job booked for the old window's start would otherwise wait for it.
    await tx
      .update(jobs)
      .set({ runAfter })
      .where(
        and(
          eq(jobs.type, "store"),
          eq(jobs.state, "queued"),
          gt(jobs.runAfter, now),
        ),
      );
  });
}

/** Queues one policy rung for an Item whatever the policy condition says; false when it is complete or already queued. */
export async function requestStoredVersion(
  db: Database,
  actorId: string,
  itemId: string,
  rungName: string,
) {
  await requirePermission(db, actorId, "transcoding:manage", server);
  const [item] = await db
    .select({ homeLibraryId: homeLibraryId() })
    .from(items)
    .where(eq(items.id, itemId))
    .limit(1);
  if (item === undefined || item.homeLibraryId === null)
    throw new AuthError("NOT_FOUND");
  const library = await loadLibrary(db, item.homeLibraryId);
  // Rungs are defined by the policy; a manual request only skips its condition.
  const rung = readStoredVersionPolicy(library.configuration)?.rungs.find(
    (candidate) => candidate.name === rungName,
  );
  if (rung === undefined) throw new AuthError("INVALID_INPUT");
  const candidates = await db
    .select({
      id: versions.id,
      itemId: versions.itemId,
      libraryId: versions.libraryId,
    })
    .from(versions)
    .where(
      and(
        eq(versions.itemId, itemId),
        eq(versions.libraryId, item.homeLibraryId),
        eq(versions.origin, "imported"),
      ),
    );
  const allowed = await permittedVersionIds(db, actorId, "view", candidates);
  if (candidates.length > 0 && allowed.size === 0)
    throw new AuthError("FORBIDDEN");
  const source = (
    await bestSources(
      db,
      and(
        eq(files.itemId, itemId),
        eq(files.libraryId, item.homeLibraryId),
        inArray(files.versionId, [...allowed]),
      ),
    )
  ).get(itemId);
  if (source === undefined || !rungFits(rung, source.video))
    throw new AuthError("CONFLICT");
  return { queued: await requestStore(db, source.fileId, rung.name) };
}
