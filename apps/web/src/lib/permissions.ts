import type { ThaliaClient } from "./api.ts";

/** One permission name, taken from the API's own group shape. */
export type Permission = Awaited<
  ReturnType<ThaliaClient["groups"]["list"]>
>[number]["permissions"][number];

// Every permission needs a key here, so the build fails when the server adds one.
const displayOrder = {
  view: 1,
  play: 2,
  download: 3,
  "manage-libraries": 4,
  "manage-metadata": 5,
  "manage-subtitles": 6,
  "manage-users": 7,
  "manage-plugins": 8,
  "manage-transcoding": 9,
  "manage-server": 10,
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
  "manage-libraries": "Manage libraries",
  "manage-metadata": "Edit metadata",
  "manage-subtitles": "Manage subtitles",
  "manage-users": "Manage users",
  "manage-plugins": "Manage plugins",
  "manage-transcoding": "Manage transcoding",
  "manage-server": "Manage server",
} satisfies Record<Permission, string>;
