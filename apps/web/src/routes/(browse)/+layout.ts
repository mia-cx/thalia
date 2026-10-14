import { client } from "$lib/api.ts";
import { loadSession } from "$lib/session.ts";
import type { LayoutLoad } from "./$types";

export const prerender = false;
export const ssr = false;

/** Sends the browser to setup or login, or hands the shell the caller and its libraries. */
export const load: LayoutLoad = async () => {
  const { me } = await loadSession();
  const libraries = await client.libraries.viewable();
  return { me, libraries };
};
