import { loadSession } from "$lib/session.ts";
import type { PageLoad } from "./$types";

export const prerender = false;
export const ssr = false;

/** Sends the browser to setup or login before anything plays; a download plays without the server. */
export const load: PageLoad = ({ url }) =>
  url.searchParams.has("offline") ? {} : loadSession();
