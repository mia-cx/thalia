import type { ThaliaClient } from "./api.ts";
import { type Permission, permissionLabels } from "./permissions.ts";

/** An Access rule with resolved names, as the API returns it. */
export type Rule = Awaited<
  ReturnType<ThaliaClient["access"]["rulesForSubject"]>
>[number];

/** The user or Group an Access rule panel is scoped to. */
export type AccessSubject = Parameters<
  ThaliaClient["access"]["rulesForSubject"]
>[0]["subject"];

/** The object an Access rule panel is scoped to. */
export type AccessObject = Parameters<
  ThaliaClient["access"]["rulesOnObject"]
>[0]["object"];

/** The Actions an object rule can name; server-only Actions stay out. */
export const objectActions: Permission[] = [
  "view",
  "play",
  "download",
  "metadata:edit",
  "subtitles:edit",
];

/** An Item kind's display name, such as "Season". */
export const kindLabels = {
  movie: "Movie",
  show: "Show",
  season: "Season",
  episode: "Episode",
} as const;

/** The page a rule's object lives on, or null when it has none. */
export function objectHref(object: Rule["object"]): string | null {
  if (object.type === "library") return `/admin/libraries/${object.id}`;
  if (object.type !== "item") return null;
  switch (object.kind) {
    case "movie":
      return `/movies/${object.id}`;
    case "show":
      return `/shows/${object.id}`;
    case "season":
      return object.showId === null
        ? null
        : `/shows/${object.showId}/seasons/${object.id}`;
    case "episode":
      return object.showId === null || object.parentId === null
        ? null
        : `/shows/${object.showId}/seasons/${object.parentId}/episodes/${object.id}`;
  }
}

/** The one-line caption summarising a Group's Access rules. */
export function groupSummary(
  group: Awaited<ReturnType<ThaliaClient["groups"]["list"]>>[number],
): string {
  if (group.builtIn && group.name === "admins") return "Can do everything";
  const parts: string[] = [];
  const allowed = group.rules.server
    .filter((rule) => rule.allowed)
    .map((rule) => permissionLabels[rule.action]);
  const denied = group.rules.server
    .filter((rule) => !rule.allowed)
    .map((rule) => permissionLabels[rule.action]);
  if (allowed.length > 0 && denied.length > 0)
    parts.push(
      `${allowed.join(", ")} allowed, ${denied.join(", ")} denied on the server`,
    );
  else if (allowed.length > 0)
    parts.push(`${allowed.join(", ")} on the server`);
  else if (denied.length > 0)
    parts.push(`${denied.join(", ")} denied on the server`);
  if (group.rules.libraries > 0)
    parts.push(
      group.rules.libraries === 1
        ? "1 Library"
        : `${group.rules.libraries} Libraries`,
    );
  if (group.rules.items > 0)
    parts.push(
      group.rules.items === 1 ? "1 Item" : `${group.rules.items} Items`,
    );
  return parts.length === 0 ? "No rules" : parts.join(" · ");
}

/** Where an inherited rule was written; server rules live on the subject's page. */
export function sourceHref(rule: Rule): string | null {
  if (rule.object.type === "server")
    return `/admin/${rule.subject.type === "user" ? "users" : "groups"}/${rule.subject.id}#permissions`;
  return objectHref(rule.object);
}
