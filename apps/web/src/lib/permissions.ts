import type { ThaliaClient } from "./api.ts";

/** One permission name, taken from the Action names an Access rule carries. */
export type Permission = Awaited<
  ReturnType<ThaliaClient["access"]["rulesForSubject"]>
>[number]["action"];

// Every permission needs a key here, so the build fails when the server adds one.
const displayOrder = {
  view: 1,
  play: 2,
  download: 3,
  "libraries:manage": 4,
  "metadata:edit": 5,
  "subtitles:edit": 6,
  "users:manage": 7,
  "plugins:manage": 8,
  "transcoding:manage": 9,
  "server:manage": 10,
} satisfies Record<Permission, number>;

/** Every permission name the server enforces, in the order the screens show them. */
export const permissionNames = Object.keys(
  displayOrder,
) as (keyof typeof displayOrder)[];

/** The readable name of each permission. */
export const permissionLabels = {
  view: "View",
  play: "Play",
  download: "Download",
  "libraries:manage": "Manage libraries",
  "metadata:edit": "Edit metadata",
  "subtitles:edit": "Manage subtitles",
  "users:manage": "Manage users",
  "plugins:manage": "Manage plugins",
  "transcoding:manage": "Manage transcoding",
  "server:manage": "Manage server",
} satisfies Record<Permission, string>;
