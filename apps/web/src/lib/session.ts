import { redirect } from "@sveltejs/kit";
import { client, ServerUnreachable } from "./api.ts";
import { readFailure } from "./errors.ts";

const savedKey = "thalia.session";

function readSaved(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(savedKey) ?? "{}");
  } catch {
    // Blocked or malformed storage keeps nothing.
    return {};
  }
}

/**
 * Runs `load` and keeps its answer under `key`, so the last answer stands in
 * while the server is unreachable and the app still opens on its downloads.
 * Without a kept answer the failure stands.
 */
export async function remembered<T>(
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  try {
    const value = await load();
    try {
      localStorage.setItem(
        savedKey,
        JSON.stringify({ ...readSaved(), [key]: value }),
      );
    } catch {}
    return value;
  } catch (error) {
    const saved = readSaved();
    if (error instanceof ServerUnreachable && key in saved)
      return saved[key] as T;
    throw error;
  }
}

/** Drops what {@link remembered} kept, so a signed-out browser opens on nobody's session. */
export function forgetSession(): void {
  try {
    localStorage.removeItem(savedKey);
  } catch {}
}

/** Sends the browser to setup or login, or answers the signed-in caller; offline, the last one seen. */
export async function loadSession() {
  const me = await remembered("me", async () => {
    const { complete } = await client.setup.status();
    if (!complete) redirect(307, "/setup");
    try {
      return await client.me();
    } catch (error) {
      if (readFailure(error).code === "UNAUTHORIZED") {
        forgetSession();
        redirect(307, "/login");
      }
      throw error;
    }
  });
  return { me };
}
