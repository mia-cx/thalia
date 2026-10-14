import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { id, instant, owned } from "./common.ts";
import { items, libraries } from "./core.ts";

/** Actions which can only name the server. */
export const serverOnlyActions = [
  "libraries:manage",
  "users:manage",
  "plugins:manage",
  "transcoding:manage",
  "server:manage",
] as const;
/** The closed list of Actions enforced by Access rules. */
export const actions = [
  "view",
  "play",
  "download",
  "metadata:edit",
  "subtitles:edit",
  ...serverOnlyActions,
] as const;
export type Action = (typeof actions)[number];
const actionList = sql.raw(
  `ARRAY[${actions.map((action) => `'${action}'`).join(",")}]::text[]`,
);
const serverActionList = sql.raw(
  `ARRAY[${serverOnlyActions.map((action) => `'${action}'`).join(",")}]::text[]`,
);

// Credentials store SHA-256 digests, never the raw token.
const tokenHash = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});
const tokenHashBytes = sql`32`;

export const users = pgTable(
  "users",
  {
    id: id(),
    username: text("username").notNull(),
    displayName: text("display_name").notNull(),
    email: text("email"),
    passwordHash: text("password_hash"),
    oidcIssuer: text("oidc_issuer"),
    oidcSubject: text("oidc_subject"),
    disabledAt: instant("disabled_at"),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "users_oidc_pair_check",
      sql`(${table.oidcIssuer} is null) = (${table.oidcSubject} is null)`,
    ),
    check(
      "users_identity_check",
      sql`${table.passwordHash} is not null or (${table.oidcIssuer} is not null and ${table.oidcSubject} is not null)`,
    ),
    uniqueIndex("users_username_unique").on(sql`lower(${table.username})`),
    uniqueIndex("users_email_unique")
      .on(sql`lower(${table.email})`)
      .where(sql`${table.email} is not null`),
    unique("users_oidc_unique").on(table.oidcIssuer, table.oidcSubject),
  ],
);

export const groups = pgTable("groups", {
  id: id(),
  name: text("name").notNull().unique(),
  builtIn: boolean("built_in").notNull().default(false),
});

export const userGroups = pgTable(
  "user_groups",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, owned),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, owned),
  },
  (table) => [
    unique("user_groups_membership_unique").on(table.userId, table.groupId),
    index("user_groups_group_idx").on(table.groupId),
  ],
);

export const userSettings = pgTable(
  "user_settings",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .unique()
      .references(() => users.id, owned),
    bitrateCapBps: bigint("bitrate_cap_bps", { mode: "bigint" }),
    contentRatingCeiling: text("content_rating_ceiling"),
    preferDirectStream: boolean("prefer_direct_stream")
      .notNull()
      .default(false),
  },
  (table) => [
    check("user_settings_bitrate_check", sql`${table.bitrateCapBps} > 0`),
  ],
);

/** One subject's allow or deny of an Action on an object. */
export const accessRules = pgTable(
  "access_rules",
  {
    id: id(),
    userId: uuid("user_id").references(() => users.id, owned),
    groupId: uuid("group_id").references(() => groups.id, owned),
    libraryId: uuid("library_id").references(() => libraries.id, owned),
    itemId: uuid("item_id").references(() => items.id, owned),
    action: text("action").$type<Action>().notNull(),
    allowed: boolean("allowed").notNull(),
  },
  (table) => [
    check(
      "access_rules_subject_check",
      sql`num_nonnulls(${table.userId}, ${table.groupId}) = 1`,
    ),
    check(
      "access_rules_object_check",
      sql`num_nonnulls(${table.libraryId}, ${table.itemId}) <= 1`,
    ),
    check(
      "access_rules_action_check",
      sql`${table.action} = ANY(${actionList})`,
    ),
    check(
      "access_rules_server_action_check",
      sql`not (${table.action} = ANY(${serverActionList})) or (${table.libraryId} is null and ${table.itemId} is null)`,
    ),
    unique("access_rules_unique")
      .on(
        table.userId,
        table.groupId,
        table.libraryId,
        table.itemId,
        table.action,
      )
      .nullsNotDistinct(),
    index("access_rules_group_idx").on(table.groupId),
    index("access_rules_library_idx").on(table.libraryId),
    index("access_rules_item_idx").on(table.itemId),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, owned),
    tokenHash: tokenHash("token_hash").notNull().unique(),
    clientName: text("client_name").notNull(),
    deviceId: text("device_id").notNull(),
    deviceName: text("device_name").notNull(),
    createdAt: instant("created_at").notNull().defaultNow(),
    lastSeenAt: instant("last_seen_at").notNull().defaultNow(),
    expiresAt: instant("expires_at"),
    revokedAt: instant("revoked_at"),
  },
  (table) => [
    check(
      "sessions_token_hash_check",
      sql`octet_length(${table.tokenHash}) = ${tokenHashBytes}`,
    ),
    index("sessions_user_seen_idx").on(table.userId, table.lastSeenAt.desc()),
  ],
);

// A pending Quick Connect login: a device waits on its secret while a
// signed-in user approves its code. The row is deleted when it logs in.
export const quickConnectRequests = pgTable(
  "quick_connect_requests",
  {
    id: id(),
    secretHash: tokenHash("secret_hash").notNull().unique(),
    code: text("code").notNull().unique(),
    clientName: text("client_name").notNull(),
    clientVersion: text("client_version").notNull(),
    deviceId: text("device_id").notNull(),
    deviceName: text("device_name").notNull(),
    // Where the request came from, so one address cannot hold unbounded rows.
    address: text("address").notNull(),
    userId: uuid("user_id").references(() => users.id, owned),
    createdAt: instant("created_at").notNull().defaultNow(),
    expiresAt: instant("expires_at").notNull(),
  },
  (table) => [
    check(
      "quick_connect_requests_secret_hash_check",
      sql`octet_length(${table.secretHash}) = ${tokenHashBytes}`,
    ),
    check(
      "quick_connect_requests_code_check",
      sql`${table.code} ~ '^[0-9]{6}$'`,
    ),
    index("quick_connect_requests_expires_idx").on(table.expiresAt),
    index("quick_connect_requests_address_idx").on(
      table.address,
      table.expiresAt,
    ),
  ],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, owned),
    name: text("name").notNull(),
    tokenHash: tokenHash("token_hash").notNull().unique(),
    createdAt: instant("created_at").notNull().defaultNow(),
    lastUsedAt: instant("last_used_at"),
    expiresAt: instant("expires_at"),
    revokedAt: instant("revoked_at"),
  },
  (table) => [
    check(
      "api_keys_token_hash_check",
      sql`octet_length(${table.tokenHash}) = ${tokenHashBytes}`,
    ),
    index("api_keys_user_idx").on(table.userId),
  ],
);

export const invites = pgTable(
  "invites",
  {
    id: id(),
    email: text("email").notNull(),
    tokenHash: tokenHash("token_hash").notNull().unique(),
    invitedBy: uuid("invited_by").references(() => users.id, {
      onDelete: "set null",
      onUpdate: "no action",
    }),
    expiresAt: instant("expires_at").notNull(),
    acceptedAt: instant("accepted_at"),
  },
  (table) => [
    check(
      "invites_token_hash_check",
      sql`octet_length(${table.tokenHash}) = ${tokenHashBytes}`,
    ),
  ],
);
