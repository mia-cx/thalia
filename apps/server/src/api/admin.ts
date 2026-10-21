import { Schema } from "effect";
import { server } from "../auth/access.ts";
import { createLocalUser, isSetupComplete } from "../auth/accounts.ts";
import {
  getUserAccess,
  listGroups,
  listUsers,
  readUserAccess,
  setLibraryAccess,
  writeUserSettings,
} from "../auth/admin.ts";
import {
  createGroup,
  requirePermission,
  setUserGroups,
} from "../auth/permissions.ts";
import { listSessions, revokeSession } from "../auth/sessions.ts";
import { readAuthSettings, writeAuthSettings } from "../auth/settings.ts";
import type { Database } from "../db/client.ts";
import {
  artworkStoreConfig,
  describeArtworkStore,
} from "../metadata/artwork-backends.ts";
import { metadataProviders } from "../metadata/providers.ts";
import {
  readWatchThresholds,
  writeWatchThresholds,
} from "../playback/history.ts";
import {
  readPlaybackSettings,
  writePlaybackSettings,
} from "../playback/settings.ts";
import type { PluginRuntime } from "../plugins/runtime.ts";
import {
  readProviderKeyNames,
  removeProviderKey,
  setProviderKey,
} from "../providers/keys.ts";
import { IdleWindow, readStoreSettings } from "../stored/policy.ts";
import { setIdleWindow } from "../stored/service.ts";
import { authenticated, authenticatedMutation, base } from "./context.ts";
import { fromHost, runApi } from "./errors.ts";
import {
  AdminUser,
  Group,
  ServerSettings,
  Session,
  UserAccess,
  UserAccount,
  WatchThresholds,
} from "./schema.ts";

function instant(value: Date): string;
function instant(value: Date | null): string | null;
function instant(value: Date | null) {
  return value === null ? null : value.toISOString();
}

const toAdminUser = (user: Awaited<ReturnType<typeof listUsers>>[number]) => ({
  ...user,
  disabledAt: instant(user.disabledAt),
  createdAt: instant(user.createdAt),
});

const toSession = (
  session: Awaited<ReturnType<typeof listSessions>>[number],
) => ({
  ...session,
  createdAt: instant(session.createdAt),
  lastSeenAt: instant(session.lastSeenAt),
  expiresAt: instant(session.expiresAt),
  revokedAt: instant(session.revokedAt),
});

const toUserAccess = (access: Awaited<ReturnType<typeof getUserAccess>>) => ({
  user: toAdminUser(access.user),
  groupIds: access.groupIds,
  libraryAccess: access.libraryAccess,
  settings: {
    bitrateCapBps:
      access.settings.bitrateCapBps === null
        ? null
        : Number(access.settings.bitrateCapBps),
    contentRatingCeiling: access.settings.contentRatingCeiling,
    preferDirectStream: access.settings.preferDirectStream,
  },
});

/** The Item kind each library medium needs a metadata provider for. */
const mediumKinds = { movies: "movie", shows: "show" } as const;

/** Reads the server settings without a caller check; the handler authorizes. */
async function readServerSettings(db: Database, plugins: PluginRuntime) {
  const config = await readAuthSettings(db);
  const providerKeys = await readProviderKeyNames(db);
  const kinds = new Set(
    (await metadataProviders(db, { plugins })).flatMap(
      (provider) => provider.kinds,
    ),
  );
  return {
    trustedProxyAddresses: config.trustedProxyAddresses,
    artworkRequiresAuth: config.artworkRequiresAuth,
    oidcConfigured: config.oidc !== null,
    oidcClientSecretSet: config.oidcClientSecretSet,
    providerKeys,
    metadataMediums: (["movies", "shows"] as const).filter((medium) =>
      kinds.has(mediumKinds[medium]),
    ),
    ...(await readPlaybackSettings(db)),
    idleWindow: (await readStoreSettings(db)).idleWindow,
    watchThresholds: await readWatchThresholds(db),
    artworkStore: describeArtworkStore(artworkStoreConfig()),
  };
}

const idInput = Schema.standardSchemaV1(Schema.Struct({ id: Schema.UUID }));
const accessOutput = Schema.standardSchemaV1(UserAccess);
const settingsOutput = Schema.standardSchemaV1(ServerSettings);

/** The setup procedures mounted under `setup`. */
export const setupProcedures = {
  status: base
    .route({
      method: "GET",
      path: "/setup/status",
      spec: (current) => ({ ...current, security: [] }),
    })
    .output(
      Schema.standardSchemaV1(
        Schema.Struct({
          complete: Schema.Boolean,
          oidcConfigured: Schema.Boolean,
          oidcName: Schema.NullOr(Schema.String),
        }),
      ),
    )
    .handler(async ({ context }) =>
      runApi(
        fromHost(async () => {
          const { oidc } = await readAuthSettings(context.db);
          return {
            complete: await isSetupComplete(context.db),
            oidcConfigured: oidc !== null,
            oidcName: oidc?.name ?? null,
          };
        }),
      ),
    ),
};

/** The user administration procedures mounted under `users`. */
export const userProcedures = {
  list: authenticated
    .route({ method: "GET", path: "/users" })
    .output(Schema.standardSchemaV1(Schema.Array(AdminUser)))
    .handler(async ({ context }) =>
      runApi(
        fromHost(async () =>
          (await listUsers(context.db, context.caller.user.id)).map(
            toAdminUser,
          ),
        ),
      ),
    ),
  get: authenticated
    .route({ method: "GET", path: "/users/{id}" })
    .input(idInput)
    .output(accessOutput)
    .handler(async ({ context, input }) =>
      runApi(
        fromHost(async () =>
          toUserAccess(
            await getUserAccess(context.db, context.caller.user.id, input.id),
          ),
        ),
      ),
    ),
  create: authenticatedMutation
    .route({ method: "POST", path: "/users" })
    .input(
      Schema.standardSchemaV1(
        Schema.Struct({
          username: Schema.String,
          password: Schema.String,
          displayName: Schema.optional(Schema.String),
        }),
      ),
    )
    .output(Schema.standardSchemaV1(UserAccount))
    .handler(async ({ context, input }) =>
      runApi(
        fromHost(() =>
          createLocalUser(context.db, context.caller.user.id, input),
        ),
      ),
    ),
  sessions: authenticated
    .route({ method: "GET", path: "/users/{id}/sessions" })
    .input(idInput)
    .output(Schema.standardSchemaV1(Schema.Array(Session)))
    .handler(async ({ context, input }) =>
      runApi(
        fromHost(async () =>
          (
            await listSessions(context.db, context.caller.user.id, input.id)
          ).map(toSession),
        ),
      ),
    ),
  revokeSession: authenticatedMutation
    .route({ method: "POST", path: "/sessions/{id}/revoke" })
    .input(idInput)
    .output(Schema.standardSchemaV1(Schema.Struct({ ok: Schema.Boolean })))
    .handler(async ({ context, input }) =>
      runApi(
        fromHost(async () => {
          await revokeSession(context.db, context.caller.user.id, input.id);
          return { ok: true };
        }),
      ),
    ),
  setGroups: authenticatedMutation
    .route({ method: "PUT", path: "/users/{id}/groups" })
    .input(
      Schema.standardSchemaV1(
        Schema.Struct({
          id: Schema.UUID,
          groupIds: Schema.Array(Schema.UUID),
        }),
      ),
    )
    .output(accessOutput)
    .handler(async ({ context, input }) =>
      runApi(
        fromHost(async () => {
          await setUserGroups(
            context.db,
            context.caller.user.id,
            input.id,
            input.groupIds,
          );
          return toUserAccess(await readUserAccess(context.db, input.id));
        }),
      ),
    ),
  setSettings: authenticatedMutation
    .route({ method: "PUT", path: "/users/{id}/settings" })
    .input(
      Schema.standardSchemaV1(
        Schema.Struct({
          id: Schema.UUID,
          bitrateCapBps: Schema.NullOr(Schema.Int),
          contentRatingCeiling: Schema.NullOr(Schema.String),
          preferDirectStream: Schema.optional(Schema.Boolean),
        }),
      ),
    )
    .output(accessOutput)
    .handler(async ({ context, input }) =>
      runApi(
        fromHost(async () => {
          await writeUserSettings(
            context.db,
            context.caller.user.id,
            input.id,
            {
              bitrateCapBps:
                input.bitrateCapBps === null
                  ? null
                  : BigInt(input.bitrateCapBps),
              contentRatingCeiling: input.contentRatingCeiling,
              preferDirectStream: input.preferDirectStream,
            },
          );
          return toUserAccess(await readUserAccess(context.db, input.id));
        }),
      ),
    ),
  setLibraryAccess: authenticatedMutation
    .route({ method: "PUT", path: "/users/{id}/libraries/{libraryId}" })
    .input(
      Schema.standardSchemaV1(
        Schema.Struct({
          id: Schema.UUID,
          libraryId: Schema.UUID,
          allowed: Schema.NullOr(Schema.Boolean),
        }),
      ),
    )
    .output(accessOutput)
    .handler(async ({ context, input }) =>
      runApi(
        fromHost(async () => {
          await setLibraryAccess(context.db, context.caller.user.id, {
            libraryId: input.libraryId,
            userId: input.id,
            allowed: input.allowed,
          });
          return toUserAccess(await readUserAccess(context.db, input.id));
        }),
      ),
    ),
};

/** The group administration procedures mounted under `groups`. */
export const groupProcedures = {
  list: authenticated
    .route({ method: "GET", path: "/groups" })
    .output(Schema.standardSchemaV1(Schema.Array(Group)))
    .handler(async ({ context }) =>
      runApi(fromHost(() => listGroups(context.db, context.caller.user.id))),
    ),
  create: authenticatedMutation
    .route({ method: "POST", path: "/groups" })
    .input(Schema.standardSchemaV1(Schema.Struct({ name: Schema.String })))
    .output(Schema.standardSchemaV1(Group))
    .handler(async ({ context, input }) =>
      runApi(
        fromHost(async () => {
          const group = await createGroup(context.db, context.caller.user.id, {
            name: input.name,
            permissions: [],
          });
          return {
            id: group.id,
            name: group.name,
            builtIn: group.builtIn,
            rules: { server: [], libraries: 0, items: 0 },
          };
        }),
      ),
    ),
};

/** The server settings procedures mounted under `settings`. */
export const settingsProcedures = {
  get: authenticated
    .route({ method: "GET", path: "/settings" })
    .output(settingsOutput)
    .handler(async ({ context }) =>
      runApi(
        fromHost(async () => {
          await requirePermission(
            context.db,
            context.caller.user.id,
            "server:manage",
            server,
          );
          return readServerSettings(context.db, context.plugins);
        }),
      ),
    ),
  update: authenticatedMutation
    .route({ method: "PATCH", path: "/settings" })
    .input(
      Schema.standardSchemaV1(
        Schema.Struct({
          trustedProxyAddresses: Schema.optional(Schema.Array(Schema.String)),
          artworkRequiresAuth: Schema.optional(Schema.Boolean),
          allowCpu4k: Schema.optional(Schema.Boolean),
          oidcClientSecret: Schema.optional(Schema.String),
          // Null clears the global cap.
          bitrateCapBps: Schema.optional(
            Schema.NullOr(
              Schema.Int.pipe(Schema.between(1, Number.MAX_SAFE_INTEGER)),
            ),
          ),
          idleWindow: Schema.optional(IdleWindow),
          watchThresholds: Schema.optional(Schema.partial(WatchThresholds)),
        }),
      ),
    )
    .output(settingsOutput)
    .handler(async ({ context, input }) =>
      runApi(
        fromHost(async () => {
          const { db } = context;
          const actorId = context.caller.user.id;
          const {
            bitrateCapBps,
            allowCpu4k,
            idleWindow,
            watchThresholds,
            ...auth
          } = input;
          await writeAuthSettings(db, actorId, auth);
          if (bitrateCapBps !== undefined || allowCpu4k !== undefined)
            await writePlaybackSettings(db, actorId, {
              ...(bitrateCapBps === undefined ? {} : { bitrateCapBps }),
              ...(allowCpu4k === undefined ? {} : { allowCpu4k }),
            });
          if (idleWindow !== undefined)
            await setIdleWindow(db, actorId, idleWindow);
          if (watchThresholds !== undefined)
            await writeWatchThresholds(db, actorId, watchThresholds);
          return readServerSettings(db, context.plugins);
        }),
      ),
    ),
  setProviderKey: authenticatedMutation
    .route({ method: "PUT", path: "/settings/providers/{name}" })
    .input(
      Schema.standardSchemaV1(
        Schema.Struct({ name: Schema.String, value: Schema.String }),
      ),
    )
    .output(settingsOutput)
    .handler(async ({ context, input }) =>
      runApi(
        fromHost(async () => {
          await setProviderKey(
            context.db,
            context.caller.user.id,
            input.name,
            input.value,
          );
          return readServerSettings(context.db, context.plugins);
        }),
      ),
    ),
  deleteProviderKey: authenticatedMutation
    .route({ method: "DELETE", path: "/settings/providers/{name}" })
    .input(Schema.standardSchemaV1(Schema.Struct({ name: Schema.String })))
    .output(settingsOutput)
    .handler(async ({ context, input }) =>
      runApi(
        fromHost(async () => {
          await removeProviderKey(
            context.db,
            context.caller.user.id,
            input.name,
          );
          return readServerSettings(context.db, context.plugins);
        }),
      ),
    ),
};
