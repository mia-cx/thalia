import { client } from "$lib/api.ts";
import { loadSession, remembered } from "$lib/session.ts";
import type { LayoutLoad } from "./$types";

export const prerender = false;
export const ssr = false;

/** Sends the browser to setup or login, or hands the shell the caller and its libraries; offline, the last ones seen. */
export const load: LayoutLoad = async () => {
  const { me } = await loadSession();
  const libraries = await remembered("libraries", () =>
    client.libraries.viewable(),
  );
  return { me, libraries };
};
