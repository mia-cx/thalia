import { Schema } from "effect";
import { actions } from "../db/schema/index.ts";
import { maxPageSize } from "./pagination.ts";

/** The kinds of library item the API exposes. */
export const ItemKind = Schema.Literal("movie", "show", "season", "episode");

/** The orders items.list pages through: newest first, or title A to Z. */
export const ItemSort = Schema.Literal("added", "title");

/** The item shape returned by list endpoints. */
export const ItemCard = Schema.Struct({
  id: Schema.UUID,
  kind: ItemKind,
  homeLibraryId: Schema.NullOr(Schema.UUID),
  title: Schema.String,
  year: Schema.NullOr(Schema.Int),
  addedAt: Schema.String,
  posterArtworkId: Schema.NullOr(Schema.UUID),
});

/** A card that also places a Season or Episode, with its owning Show and the artwork heroes and landscape cards draw. */
export const BrowseCard = Schema.Struct({
  ...ItemCard.fields,
  backdropArtworkId: Schema.NullOr(Schema.UUID),
  logoArtworkId: Schema.NullOr(Schema.UUID),
  thumbArtworkId: Schema.NullOr(Schema.UUID),
  parentId: Schema.NullOr(Schema.UUID),
  seasonNumber: Schema.NullOr(Schema.Int),
  episodeNumber: Schema.NullOr(Schema.Int),
  episodeEndNumber: Schema.NullOr(Schema.Int),
  show: Schema.NullOr(
    Schema.Struct({
      id: Schema.UUID,
      title: Schema.String,
      posterArtworkId: Schema.NullOr(Schema.UUID),
      backdropArtworkId: Schema.NullOr(Schema.UUID),
      logoArtworkId: Schema.NullOr(Schema.UUID),
    }),
  ),
});

/** One named row of Home, with resume progress on in-progress entries. */
export const Shelf = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  entries: Schema.Array(
    Schema.Struct({
      item: BrowseCard,
      progress: Schema.NullOr(
        Schema.Struct({
          positionSeconds: Schema.Number,
          durationSeconds: Schema.NullOr(Schema.Number),
        }),
      ),
    }),
  ),
});

/** A detail's child: its browse card with the overview, runtime and the caller's progress an episode row shows. */
export const DetailChild = Schema.Struct({
  ...BrowseCard.fields,
  overview: Schema.NullOr(Schema.String),
  durationSeconds: Schema.NullOr(Schema.Number),
  progress: Schema.NullOr(
    Schema.Struct({
      positionSeconds: Schema.Number,
      completed: Schema.Boolean,
      updatedAt: Schema.String,
    }),
  ),
});

/** The item shape returned by detail endpoints. */
export const ItemDetail = Schema.Struct({
  ...BrowseCard.fields,
  overview: Schema.NullOr(Schema.String),
  contentRating: Schema.NullOr(Schema.String),
  genres: Schema.Array(Schema.String),
  tags: Schema.Array(Schema.String),
  metadataState: Schema.Literal("pending", "matched", "unmatched"),
  updatedAt: Schema.String,
  credits: Schema.Array(
    Schema.Struct({
      contributorId: Schema.UUID,
      name: Schema.String,
      role: Schema.String,
      character: Schema.NullOr(Schema.String),
    }),
  ),
  /** Whether the caller may download this Item's files. */
  canDownload: Schema.Boolean,
  versions: Schema.Array(
    Schema.Struct({
      id: Schema.UUID,
      libraryId: Schema.UUID,
      label: Schema.String,
      format: Schema.Literal("video", "audio", "ebook", "image"),
      durationSeconds: Schema.NullOr(Schema.Number),
      bytes: Schema.Number,
      /** Whether the caller may play this Version. */
      playable: Schema.Boolean,
      /** The container of the Version's first File. */
      container: Schema.NullOr(Schema.String),
      streams: Schema.Array(
        Schema.Struct({
          index: Schema.Int,
          kind: Schema.Literal("video", "audio", "subtitle"),
          codec: Schema.String,
          profile: Schema.NullOr(Schema.String),
          language: Schema.NullOr(Schema.String),
          title: Schema.NullOr(Schema.String),
          channels: Schema.NullOr(Schema.Int),
          width: Schema.NullOr(Schema.Int),
          height: Schema.NullOr(Schema.Int),
          hdr: Schema.NullOr(Schema.String),
          default: Schema.Boolean,
          forced: Schema.Boolean,
        }),
      ),
    }),
  ),
  children: Schema.Array(DetailChild),
});

/** The library fields visible to callers who may browse it. */
export const ViewableLibrary = Schema.Struct({
  id: Schema.UUID,
  name: Schema.String,
  medium: Schema.Literal("movies", "shows"),
});

/** The library shape returned by administration endpoints. */
export const Library = Schema.Struct({
  id: Schema.UUID,
  name: Schema.String,
  medium: Schema.Literal("movies", "shows"),
  /** The absolute folders the library reads, first root first. */
  roots: Schema.Array(Schema.Struct({ id: Schema.UUID, path: Schema.String })),
});

/** One Library's dashboard numbers over its playable Items (movies, Episodes) and their imported Versions. */
export const LibraryStats = Schema.Struct({
  libraryId: Schema.UUID,
  items: Schema.Int,
  versions: Schema.Int,
  files: Schema.Int,
  bytes: Schema.Number,
  runtimeSeconds: Schema.Number,
  addedLast30Days: Schema.Int,
  multiVersionItems: Schema.Int,
  resolution: Schema.Struct({
    uhd: Schema.Int,
    fullHd: Schema.Int,
    hd: Schema.Int,
    lower: Schema.Int,
    unknown: Schema.Int,
  }),
  dynamicRange: Schema.Struct({
    sdr: Schema.Int,
    hdr: Schema.Int,
    dolbyVision: Schema.Int,
  }),
  codecs: Schema.Array(
    Schema.Struct({ codec: Schema.String, versions: Schema.Int }),
  ),
  /** Items of each kind in the library. */
  kinds: Schema.Struct({
    movies: Schema.Int,
    shows: Schema.Int,
    seasons: Schema.Int,
    episodes: Schema.Int,
  }),
});

/** Server-wide media totals for the Overview's media breakdown. */
export const LibrarySummary = Schema.Struct({
  movies: Schema.Int,
  shows: Schema.Int,
  seasons: Schema.Int,
  episodes: Schema.Int,
  versions: Schema.Int,
  files: Schema.Int,
  bytes: Schema.Number,
  runtimeSeconds: Schema.Number,
});

/** The metadata an Item can be missing, as the Overview counts it. */
export const MetadataGap = Schema.Literal(
  "poster",
  "backdrop",
  "overview",
  "providerIds",
  "still",
);

/** One Library's count of Items missing each piece of metadata. */
export const LibraryMetadataGaps = Schema.Struct({
  libraryId: Schema.UUID,
  poster: Schema.Int,
  backdrop: Schema.Int,
  overview: Schema.Int,
  providerIds: Schema.Int,
  still: Schema.Int,
});

/** An Item missing a piece of metadata, with what the Overview needs to name and link it. */
export const MetadataGapItem = Schema.Struct({
  id: Schema.UUID,
  kind: ItemKind,
  title: Schema.String,
  year: Schema.NullOr(Schema.Int),
  parentId: Schema.NullOr(Schema.UUID),
  show: Schema.NullOr(Schema.Struct({ id: Schema.UUID, title: Schema.String })),
  seasonNumber: Schema.NullOr(Schema.Int),
  episodeNumber: Schema.NullOr(Schema.Int),
});

/** One Library root as free-space reporting names it. */
export const SpaceRoot = Schema.Struct({
  id: Schema.UUID,
  libraryId: Schema.UUID,
  libraryName: Schema.String,
  path: Schema.String,
  /** Bytes of media files stored on this root. */
  mediaBytes: Schema.Number,
});

/** One filesystem holding Library roots, or one root the server can't read. */
export const FilesystemSpace = Schema.Union(
  Schema.Struct({
    state: Schema.Literal("available"),
    totalBytes: Schema.Number,
    availableBytes: Schema.Number,
    usedBytes: Schema.Number,
    roots: Schema.Array(SpaceRoot),
  }),
  Schema.Struct({
    state: Schema.Literal("unavailable"),
    roots: Schema.Array(SpaceRoot),
  }),
);

/** The fields accepted when a library is created. */
export const LibraryInput = Schema.Struct({
  name: Schema.String,
  medium: Schema.Literal("movies", "shows"),
  roots: Schema.Array(Schema.String),
});

/** A library edit: a new name, and the whole new root list, where an `id` keeps and repoints that root. */
export const LibraryUpdate = Schema.Struct({
  id: Schema.UUID,
  name: Schema.optional(Schema.String),
  roots: Schema.optional(
    Schema.Array(
      Schema.Struct({ id: Schema.optional(Schema.UUID), path: Schema.String }),
    ),
  ),
});

/** An absolute filesystem path input: starts at / and holds no NUL. */
export const AbsolutePath = Schema.String.pipe(
  Schema.filter((path) => path.startsWith("/") && !path.includes("\0"), {
    message: () => "Enter an absolute path, like /srv/movies.",
  }),
);

/** One folder's direct child folders, answered to the admin folder browser. */
export const FolderListing = Schema.Struct({
  /** The folder that was listed, after normalisation. */
  path: Schema.String,
  /** Its direct child folders in natural order; dot-folders and symlinks stay hidden. */
  folders: Schema.Array(
    Schema.Struct({ name: Schema.String, path: Schema.String }),
  ),
});

/** How many recognised Items a scan preview may list as examples; REST sends a query string, RPC a number. */
export const PreviewExamples = Schema.Union(
  Schema.Number,
  Schema.NumberFromString,
).pipe(
  Schema.filter(
    (count) => Number.isInteger(count) && count >= 0 && count <= 20,
    { message: () => "examples must be an integer from 0 to 20, inclusive" },
  ),
);

/** A recognised Item a scan preview shows as an example. */
export const ScanPreviewExample = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("movie"),
    title: Schema.String,
    year: Schema.NullOr(Schema.Number),
    folder: Schema.String,
    files: Schema.Int,
  }),
  Schema.Struct({
    kind: Schema.Literal("show"),
    title: Schema.String,
    year: Schema.NullOr(Schema.Number),
    folder: Schema.String,
    seasons: Schema.Array(Schema.Int),
    episodes: Schema.Int,
  }),
);

/** What a scan of one folder would find, without writing anything. */
export const ScanPreview = Schema.Struct({
  counts: Schema.Union(
    Schema.Struct({ movie: Schema.Int }),
    Schema.Struct({
      show: Schema.Int,
      season: Schema.Int,
      episode: Schema.Int,
    }),
  ),
  /** Video files that are neither recognised nor extras. */
  unrecognised: Schema.Int,
  examples: Schema.Array(ScanPreviewExample),
  /** Why the preview found nothing, or null when it found something. */
  reason: Schema.NullOr(
    Schema.Literal("missing", "not-a-folder", "empty", "unrecognised"),
  ),
});

/** The authenticated caller returned by the me procedure. */
export const Me = Schema.Struct({
  user: Schema.Struct({
    id: Schema.UUID,
    username: Schema.String,
    displayName: Schema.String,
  }),
  credential: Schema.Struct({
    kind: Schema.Literal("session", "api-key"),
    id: Schema.UUID,
  }),
  admin: Schema.Boolean,
});

/** The page size input: REST sends a query string, RPC a number. */
export const PageSize = Schema.Union(
  Schema.Number,
  Schema.NumberFromString,
).pipe(
  Schema.filter(
    (size) => Number.isInteger(size) && size >= 1 && size <= maxPageSize,
    {
      message: () =>
        `limit must be an integer from 1 to ${maxPageSize}, inclusive`,
    },
  ),
);

/** Builds a paginated connection shape over an item schema. */
export function connection<A, I, R>(item: Schema.Schema<A, I, R>) {
  return Schema.Struct({
    items: Schema.Array(item),
    cursor: Schema.NullOr(Schema.String),
  });
}

/** The flat permission names the auth slice enforces. */
export const PermissionName = Schema.Literal(...actions);

/** The account shape user creation returns. */
export const UserAccount = Schema.Struct({
  id: Schema.UUID,
  username: Schema.String,
  displayName: Schema.String,
});

/** The user shape the admin screens list and edit. */
export const AdminUser = Schema.Struct({
  id: Schema.UUID,
  username: Schema.String,
  displayName: Schema.String,
  email: Schema.NullOr(Schema.String),
  disabledAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});

/** A Group with a summary of its Access rules: its server rules, and how many Libraries and Items it has rules on. */
export const Group = Schema.Struct({
  id: Schema.UUID,
  name: Schema.String,
  builtIn: Schema.Boolean,
  rules: Schema.Struct({
    server: Schema.Array(
      Schema.Struct({ action: PermissionName, allowed: Schema.Boolean }),
    ),
    libraries: Schema.Int,
    items: Schema.Int,
  }),
});

/** The per-user bitrate cap, content-rating ceiling and direct-stream preference. */
export const UserSettings = Schema.Struct({
  bitrateCapBps: Schema.NullOr(Schema.Int),
  contentRatingCeiling: Schema.NullOr(Schema.String),
  preferDirectStream: Schema.Boolean,
});

/** One user's full access shape behind the per-user screen. */
export const UserAccess = Schema.Struct({
  user: AdminUser,
  groupIds: Schema.Array(Schema.UUID),
  libraryAccess: Schema.Array(
    Schema.Struct({ libraryId: Schema.UUID, allowed: Schema.Boolean }),
  ),
  settings: UserSettings,
});

/** A device session row the admin can inspect and revoke. */
export const Session = Schema.Struct({
  id: Schema.UUID,
  userId: Schema.UUID,
  clientName: Schema.String,
  deviceId: Schema.String,
  deviceName: Schema.String,
  createdAt: Schema.String,
  lastSeenAt: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
  revokedAt: Schema.NullOr(Schema.String),
});

/** How long a play must run before it counts: minutes, or a share of the runtime. */
export const WatchThreshold = Schema.Struct({
  unit: Schema.Literal("minutes", "percent"),
  value: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
}).pipe(
  Schema.filter(
    (threshold) => threshold.unit === "minutes" || threshold.value <= 100,
    { message: () => "a percentage is at most 100" },
  ),
);
export type WatchThreshold = typeof WatchThreshold.Type;

/** One threshold per medium. */
export const WatchThresholds = Schema.Struct({
  movies: WatchThreshold,
  shows: WatchThreshold,
});
export type WatchThresholds = typeof WatchThresholds.Type;

/** The server settings the admin reads; no secret ever appears. */
export const ServerSettings = Schema.Struct({
  trustedProxyAddresses: Schema.Array(Schema.String),
  artworkRequiresAuth: Schema.Boolean,
  oidcConfigured: Schema.Boolean,
  oidcClientSecretSet: Schema.Boolean,
  providerKeys: Schema.Array(Schema.String),
  metadataMediums: Schema.Array(Schema.Literal("movies", "shows")),
  bitrateCapBps: Schema.NullOr(Schema.Int),
  allowCpu4k: Schema.Boolean,
  idleWindow: Schema.Struct({ start: Schema.String, end: Schema.String }),
  watchThresholds: WatchThresholds,
  artworkStore: Schema.Struct({
    backend: Schema.Literal("colocated", "configured-path", "s3"),
    path: Schema.NullOr(Schema.String),
    bucket: Schema.NullOr(Schema.String),
    endpoint: Schema.NullOr(Schema.String),
  }),
});

/** A live or queued playback session as the sessions dashboard lists it. */
export const PlaybackSession = Schema.Struct({
  id: Schema.UUID,
  state: Schema.Literal("queued", "starting", "playing", "stopped"),
  playMethod: Schema.Literal("direct-play", "remux", "transcode"),
  user: Schema.Struct({ id: Schema.UUID, displayName: Schema.String }),
  clientName: Schema.NullOr(Schema.String),
  deviceName: Schema.NullOr(Schema.String),
  item: BrowseCard,
  version: Schema.Struct({
    id: Schema.UUID,
    label: Schema.String,
    durationSeconds: Schema.NullOr(Schema.Number),
  }),
  positionSeconds: Schema.NullOr(Schema.Number),
  // What a transcode converts; empty for direct play, remux and stored Versions.
  reasons: Schema.Array(Schema.Literal("video", "audio", "subtitles", "hdr")),
  // Stored rung names, the live transcode height such as "720p", or "source".
  rungs: Schema.Array(Schema.String),
  transcoder: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  lastSeenAt: Schema.String,
});

/** Store job progress: running encodes with finished segments, and the queue. */
export const StoreStatus = Schema.Struct({
  running: Schema.Array(
    Schema.Struct({
      jobId: Schema.UUID,
      item: BrowseCard,
      rung: Schema.String,
      segmentsDone: Schema.Int,
      segmentsTotal: Schema.Int,
    }),
  ),
  queued: Schema.Struct({
    total: Schema.Int,
    next: Schema.Array(
      Schema.Struct({
        jobId: Schema.UUID,
        item: BrowseCard,
        rung: Schema.String,
        runAfter: Schema.String,
      }),
    ),
  }),
});

/**
 * The newest scan run's job counts and newest job for one library, plus its
 * failures: files any scan skipped, and the run's failed scan jobs.
 */
export const ScanStatus = Schema.Struct({
  libraryId: Schema.UUID,
  counts: Schema.Struct({
    queued: Schema.Int,
    running: Schema.Int,
    completed: Schema.Int,
    failed: Schema.Int,
  }),
  latest: Schema.NullOr(
    Schema.Struct({
      id: Schema.UUID,
      state: Schema.Literal("queued", "running", "completed", "failed"),
      error: Schema.NullOr(Schema.String),
    }),
  ),
  runId: Schema.NullOr(Schema.UUID),
  /** Newest first, at most 100 items; `total` counts them all. */
  failures: Schema.Struct({
    total: Schema.Int,
    items: Schema.Array(
      Schema.Struct({
        /** The scan_failures row id for a file; the job id for a job. */
        id: Schema.UUID,
        kind: Schema.Literal("file", "job"),
        /** Root-relative for a file; the job's library-relative folder for a job. */
        path: Schema.String,
        /** The root's path for a file; null for a job. */
        root: Schema.NullOr(Schema.String),
        reason: Schema.Literal("unreadable", "no-video", "error"),
        /** The full error text, such as ffprobe's stderr. */
        detail: Schema.String,
        at: Schema.String,
      }),
    ),
  }),
});

/** One whole-Library scan: live while running, then the Library's last-scan summary. */
export const ScanRun = Schema.Struct({
  id: Schema.UUID,
  libraryId: Schema.UUID,
  state: Schema.Literal("running", "completed", "failed", "interrupted"),
  total: Schema.Int,
  checked: Schema.Int,
  added: Schema.Int,
  changed: Schema.Int,
  removed: Schema.Int,
  unmatched: Schema.Int,
  currentFolder: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
});

/** A cross-process event streamed to subscribed clients. */
export const ApiEvent = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("library.changed"),
    libraryId: Schema.UUID,
  }),
  Schema.Struct({
    kind: Schema.Literal("job.progress"),
    jobId: Schema.UUID,
    state: Schema.Literal("queued", "running", "completed", "failed"),
  }),
  Schema.Struct({
    kind: Schema.Literal("session.state"),
    sessionId: Schema.UUID,
    state: Schema.Literal("queued", "starting", "playing", "stopped"),
  }),
  Schema.Struct({
    kind: Schema.Literal("segment.ready"),
    sessionId: Schema.UUID,
    index: Schema.Int,
  }),
  Schema.Struct({
    kind: Schema.Literal("scan.progress"),
    run: ScanRun,
  }),
  Schema.Struct({
    kind: Schema.Literal("user-data.changed"),
    userId: Schema.UUID,
    // Mutable, as the events table's JSON column types its arrays.
    itemIds: Schema.mutable(Schema.Array(Schema.UUID)),
  }),
);
