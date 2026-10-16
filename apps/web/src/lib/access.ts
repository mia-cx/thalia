import type { ThaliaClient } from "./api.ts";
import type { Permission } from "./permissions.ts";

/** An Access rule with resolved names, as the API returns it. */
export type Rule = Awaited<
  ReturnType<ThaliaClient["access"]["rulesForSubject"]>
>[number];

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

/** Where an inherited rule was written; server rules live on the subject's page. */
export function sourceHref(rule: Rule): string | null {
  if (rule.object.type === "server")
    return `/admin/${rule.subject.type === "user" ? "users" : "groups"}/${rule.subject.id}#permissions`;
  return objectHref(rule.object);
}
