/**
 * Where the server mounts the web app (ADR 0017); `svelte.config.js` sets
 * `paths.base` to it. Prefix every link, `goto` and redirect with it: other
 * top-level paths belong to the Jellyfin layer.
 */
export const webBase = "/web";
