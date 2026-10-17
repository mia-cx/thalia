import { eq } from "drizzle-orm";
import { getItemView, listVersionViews } from "../api/views.ts";
import { AuthError } from "../auth/errors.ts";
import { files } from "../db/schema/index.ts";
import { creditsStartSeconds } from "../mediums/video-common/credits.ts";
import { json, type Route, type UserContext } from "./http.ts";
import { requiredGuid, ticksPerSecond, toGuid } from "./request.ts";

/** A deterministic GUID per Version and segment type, so clients can cache the segment. */
async function segmentGuid(versionId: string, type: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${versionId}:${type}`),
    ),
  ).slice(0, 16);
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Answers the Item's media segments. Only credits are exposed, as an `Outro`
 * from the credits chapter to the end of the file; everything else is an
 * empty list, which clients read as "no skip buttons".
 */
async function segments({ db, caller, query, params }: UserContext) {
  const itemId = requiredGuid(params.itemId);
  const view = await getItemView(db, caller.user.id, itemId);
  if (view === undefined) throw new AuthError("NOT_FOUND");
  const include = new Set(
    query.list("includeSegmentTypes").map((type) => type.toLowerCase()),
  );
  const segments = [];
  if (include.size === 0 || include.has("outro")) {
    // The default Version is the first view, as PlaybackInfo's default source.
    const [version] = await listVersionViews(db, caller.user.id, itemId);
    if (version !== undefined) {
      const duration = version.durationSeconds ?? version.file.durationSeconds;
      const [file] = await db
        .select({ chapters: files.chapters })
        .from(files)
        .where(eq(files.id, version.file.id))
        .limit(1);
      const start =
        file === undefined || duration === null
          ? null
          : creditsStartSeconds(file.chapters, duration);
      if (start !== null && duration !== null)
        segments.push({
          Id: await segmentGuid(version.id, "Outro"),
          ItemId: toGuid(itemId),
          Type: "Outro",
          StartTicks: Math.round(start * ticksPerSecond),
          EndTicks: Math.round(duration * ticksPerSecond),
        });
    }
  }
  return json({
    Items: segments,
    TotalRecordCount: segments.length,
    StartIndex: 0,
  });
}

export const segmentRoutes: Route[] = [
  {
    method: "GET",
    path: "/MediaSegments/{itemId}",
    handle: (context) => segments(context),
  },
];
