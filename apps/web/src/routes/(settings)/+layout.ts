import { redirect } from "@sveltejs/kit";
import { webBase } from "$lib/paths.js";
import { loadSession } from "$lib/session.ts";
import type { LayoutLoad } from "./$types";

export const prerender = false;
export const ssr = false;

/** Sends the browser to setup or login, hands the shell the caller, and moves non-admins off /admin. */
export const load: LayoutLoad = async ({ url }) => {
  const session = await loadSession();
  if (!session.me.admin && url.pathname.startsWith(`${webBase}/admin`))
    redirect(307, `${webBase}/settings/account`);
  return session;
};
