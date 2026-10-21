import { redirect } from "@sveltejs/kit";
import { webBase } from "$lib/paths.js";
import { client } from "./api.ts";
import { readFailure } from "./errors.ts";

/** Sends the browser to setup or login, or answers the signed-in caller. */
export async function loadSession() {
  const { complete } = await client.setup.status();
  if (!complete) redirect(307, `${webBase}/setup`);
  try {
    return { me: await client.me() };
  } catch (error) {
    if (readFailure(error).code === "UNAUTHORIZED")
      redirect(307, `${webBase}/login`);
    throw error;
  }
}
