import { Effect, Schema } from "effect";
import { loadVisibility } from "../auth/visibility.ts";
import { libraries } from "../db/schema/index.ts";
import {
  FolderError,
  listFolders,
  previewFolder,
} from "../libraries/folders.ts";
import {
  createLibrary,
  deleteLibrary,
  getLibrary,
  libraryScanStatus,
  listLibraries,
  RootError,
  scanLibrary,
  updateLibrary,
} from "../libraries/service.ts";
import {
  libraryFreeSpace,
  libraryMetadataGaps,
  libraryStats,
  librarySummary,
  metadataGapItems,
} from "../libraries/stats.ts";
import { StoredVersionPolicy } from "../stored/policy.ts";
import {
  getStoredVersionPolicy,
  setStoredVersionPolicy,
} from "../stored/service.ts";
import { authenticated, authenticatedMutation } from "./context.ts";
import { ApiError, fromHost, runApi } from "./errors.ts";
import { decodeTitleCursor } from "./pagination.ts";
import {
  AbsolutePath,
  connection,
  FilesystemSpace,
  FolderListing,
  Library,
  LibraryInput,
  LibraryMetadataGaps,
  LibraryStats,
  LibrarySummary,
  LibraryUpdate,
  MetadataGap,
  MetadataGapItem,
  PageSize,
  PreviewExamples,
  ScanPreview,
  ScanStatus,
  ViewableLibrary,
} from "./schema.ts";

const idInput = Schema.standardSchemaV1(Schema.Struct({ id: Schema.UUID }));

/**
 * Like `fromHost`, but host errors with an API shape become typed failures:
 * a refused root answers BAD_REQUEST with its index as `data.root`, and a
 * folder browse failure answers with the code it carries.
 */
const libraryHost = <A>(run: () => Promise<A>) =>
  fromHost(run).pipe(
    Effect.catchAllDefect((defect) =>
      defect instanceof RootError
        ? Effect.fail(
            new ApiError({
              code: "BAD_REQUEST",
              reason: defect.message,
              ...(defect.root === undefined
                ? {}
                : { data: { root: defect.root } }),
            }),
          )
        : defect instanceof FolderError
          ? Effect.fail(
              new ApiError({ code: defect.code, reason: defect.message }),
            )
          : Effect.die(defect),
    ),
  );
const libraryOutput = Schema.standardSchemaV1(Library);

const viewable = authenticated
  .route({ method: "GET", path: "/libraries/viewable" })
  .output(Schema.standardSchemaV1(Schema.Array(ViewableLibrary)))
  .handler(async ({ context }) =>
    runApi(
      fromHost(async () => {
        const visibility = await loadVisibility(
          context.db,
          context.caller.user.id,
        );
        return context.db
          .select({
            id: libraries.id,
            name: libraries.name,
            medium: libraries.medium,
          })
          .from(libraries)
          .where(visibility.library())
          .orderBy(libraries.medium, libraries.name);
      }),
    ),
  );

const list = authenticated
  .route({ method: "GET", path: "/libraries" })
  .output(Schema.standardSchemaV1(Schema.Array(Library)))
  .handler(async ({ context }) =>
    runApi(fromHost(() => listLibraries(context.db, context.caller.user.id))),
  );

const get = authenticated
  .route({ method: "GET", path: "/libraries/{id}" })
  .input(idInput)
  .output(libraryOutput)
  .handler(async ({ context, input }) =>
    runApi(
      fromHost(() => getLibrary(context.db, context.caller.user.id, input.id)),
    ),
  );

const create = authenticatedMutation
  .route({ method: "POST", path: "/libraries" })
  .input(Schema.standardSchemaV1(LibraryInput))
  .output(libraryOutput)
  .handler(async ({ context, input }) =>
    runApi(
      libraryHost(() =>
        createLibrary(context.db, context.caller.user.id, input),
      ),
    ),
  );

const update = authenticatedMutation
  .route({ method: "PATCH", path: "/libraries/{id}" })
  .input(Schema.standardSchemaV1(LibraryUpdate))
  .output(libraryOutput)
  .handler(async ({ context, input: { id, ...changes } }) =>
    runApi(
      libraryHost(() =>
        updateLibrary(context.db, context.caller.user.id, id, changes),
      ),
    ),
  );

const remove = authenticatedMutation
  .route({ method: "DELETE", path: "/libraries/{id}" })
  .input(idInput)
  .output(Schema.standardSchemaV1(Schema.Struct({ ok: Schema.Boolean })))
  .handler(async ({ context, input }) =>
    runApi(
      fromHost(() =>
        deleteLibrary(context.db, context.caller.user.id, input.id),
      ),
    ),
  );

const scan = authenticatedMutation
  .route({ method: "POST", path: "/libraries/{id}/scan" })
  .input(idInput)
  .output(Schema.standardSchemaV1(Schema.Struct({ jobId: Schema.UUID })))
  .handler(async ({ context, input }) =>
    runApi(
      fromHost(() => scanLibrary(context.db, context.caller.user.id, input.id)),
    ),
  );

const scanStatus = authenticated
  .route({ method: "GET", path: "/libraries/{id}/scan-status" })
  .input(
    Schema.standardSchemaV1(
      Schema.Struct({
        id: Schema.UUID,
        runId: Schema.optional(Schema.UUID),
      }),
    ),
  )
  .output(Schema.standardSchemaV1(ScanStatus))
  .handler(async ({ context, input }) =>
    runApi(
      fromHost(() =>
        libraryScanStatus(
          context.db,
          context.caller.user.id,
          input.id,
          input.runId,
        ),
      ),
    ),
  );

const policyOutput = Schema.standardSchemaV1(
  Schema.Struct({ policy: Schema.NullOr(StoredVersionPolicy) }),
);

const storedVersions = authenticated
  .route({ method: "GET", path: "/libraries/{id}/stored-versions" })
  .input(idInput)
  .output(policyOutput)
  .handler(async ({ context, input }) =>
    runApi(
      fromHost(() =>
        getStoredVersionPolicy(context.db, context.caller.user.id, input.id),
      ),
    ),
  );

const setStoredVersions = authenticatedMutation
  .route({ method: "PUT", path: "/libraries/{id}/stored-versions" })
  .input(
    Schema.standardSchemaV1(
      Schema.Struct({
        id: Schema.UUID,
        policy: Schema.NullOr(StoredVersionPolicy),
      }),
    ),
  )
  .output(policyOutput)
  .handler(async ({ context, input }) =>
    runApi(
      fromHost(() =>
        setStoredVersionPolicy(
          context.db,
          context.caller.user.id,
          input.id,
          input.policy,
        ),
      ),
    ),
  );

const folders = authenticated
  .route({ method: "GET", path: "/folders" })
  .input(
    Schema.standardSchemaV1(
      Schema.Struct({ path: Schema.optional(AbsolutePath) }),
    ),
  )
  .output(Schema.standardSchemaV1(FolderListing))
  .handler(async ({ context, input }) =>
    runApi(
      libraryHost(() =>
        listFolders(context.db, context.caller.user.id, input.path ?? "/"),
      ),
    ),
  );

const optionalIdInput = Schema.standardSchemaV1(
  Schema.Struct({ id: Schema.optional(Schema.UUID) }),
);

const stats = authenticated
  .route({ method: "GET", path: "/libraries/stats" })
  .input(optionalIdInput)
  .output(Schema.standardSchemaV1(Schema.Array(LibraryStats)))
  .handler(async ({ context, input }) =>
    runApi(
      fromHost(() =>
        libraryStats(context.db, context.caller.user.id, input.id),
      ),
    ),
  );

const metadataGaps = authenticated
  .route({ method: "GET", path: "/libraries/metadata-gaps" })
  .input(optionalIdInput)
  .output(Schema.standardSchemaV1(Schema.Array(LibraryMetadataGaps)))
  .handler(async ({ context, input }) =>
    runApi(
      fromHost(() =>
        libraryMetadataGaps(context.db, context.caller.user.id, input.id),
      ),
    ),
  );

const gapItems = authenticated
  .route({ method: "GET", path: "/libraries/metadata-gaps/items" })
  .input(
    Schema.standardSchemaV1(
      Schema.Struct({
        libraryId: Schema.UUID,
        gap: MetadataGap,
        cursor: Schema.optional(Schema.String),
        limit: Schema.optional(PageSize),
      }),
    ),
  )
  .output(Schema.standardSchemaV1(connection(MetadataGapItem)))
  .handler(async ({ context, input }) =>
    runApi(
      Effect.gen(function* () {
        const after =
          input.cursor === undefined
            ? undefined
            : decodeTitleCursor(input.cursor);
        if (input.cursor !== undefined && after === undefined)
          return yield* new ApiError({
            code: "BAD_REQUEST",
            reason: "Unknown cursor.",
          });
        return yield* fromHost(() =>
          metadataGapItems(context.db, context.caller.user.id, {
            libraryId: input.libraryId,
            gap: input.gap,
            ...(after === undefined ? {} : { after }),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
          }),
        );
      }),
    ),
  );

const summary = authenticated
  .route({ method: "GET", path: "/libraries/summary" })
  .output(Schema.standardSchemaV1(LibrarySummary))
  .handler(async ({ context }) =>
    runApi(fromHost(() => librarySummary(context.db, context.caller.user.id))),
  );

const freeSpace = authenticated
  .route({ method: "GET", path: "/libraries/free-space" })
  .output(Schema.standardSchemaV1(Schema.Array(FilesystemSpace)))
  .handler(async ({ context }) =>
    runApi(
      fromHost(() => libraryFreeSpace(context.db, context.caller.user.id)),
    ),
  );

const preview = authenticated
  .route({ method: "GET", path: "/folders/preview" })
  .input(
    Schema.standardSchemaV1(
      Schema.Struct({
        folder: AbsolutePath,
        medium: Schema.Literal("movies", "shows"),
        examples: Schema.optional(PreviewExamples),
      }),
    ),
  )
  .output(Schema.standardSchemaV1(ScanPreview))
  .handler(async ({ context, input, signal }) =>
    runApi(
      libraryHost(() =>
        previewFolder(
          context.db,
          context.caller.user.id,
          input.folder,
          input.medium,
          { examples: input.examples, signal },
        ),
      ),
    ),
  );

/** The library browsing and administration procedures mounted under `libraries`. */
export const libraryProcedures = {
  viewable,
  list,
  get,
  folders,
  preview,
  create,
  update,
  delete: remove,
  scan,
  scanStatus,
  stats,
  summary,
  metadataGaps,
  metadataGapItems: gapItems,
  freeSpace,
  storedVersions,
  setStoredVersions,
};
