/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

// Caches the app shell so Thalia opens without its server. API calls and
// media never pass through here: the worker answers shell requests, and
// artwork the server can't send from what downloads saved in OPFS.

import { savedArtwork } from "$lib/downloads/artwork.ts";
import { build, files, prerendered, version } from "$service-worker";

const worker = self as unknown as ServiceWorkerGlobalScope;

const shellCache = `shell-${version}`;
const fallback = "/200.html";
const shell = new Set([...build, ...files, ...prerendered, fallback]);
// The api role's own routes, opened directly by OIDC redirects or a media URL.
const serverPaths = ["/api/", "/rpc/", "/healthz", "/readyz"];

worker.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(shellCache)
      .then((cache) => cache.addAll([...shell]))
      .then(() => worker.skipWaiting()),
  );
});

worker.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== shellCache)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => worker.clients.claim()),
  );
});

async function navigate(request: Request): Promise<Response> {
  try {
    const response = await fetch(request);
    // A 5xx on a page load is a proxy whose upstream is down, or a server
    // too broken to serve files; the shell explains it better.
    if (response.status < 500) return response;
  } catch {
    // Offline or refused: fall through to the cached shell.
  }
  const cache = await caches.open(shellCache);
  const cached =
    (await cache.match(new URL(request.url).pathname)) ??
    (await cache.match(fallback));
  return cached ?? Response.error();
}

async function asset(request: Request): Promise<Response> {
  const cached = await caches.match(request, { cacheName: shellCache });
  return cached ?? fetch(request);
}

const artworkPath = "/api/artwork/";

/** The server's artwork when it answers, else a download's saved copy at any width. */
async function artwork(request: Request, id: string): Promise<Response> {
  let response: Response | undefined;
  try {
    response = await fetch(request);
    if (response.status < 500) return response;
  } catch {
    // Offline or refused: try the saved copy.
  }
  const file = await navigator.storage.getDirectory().then(
    (root) => savedArtwork(root, id),
    () => undefined,
  );
  if (file !== undefined) return new Response(file);
  return response ?? Response.error();
}

worker.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== worker.location.origin) return;
  if (url.pathname.startsWith(artworkPath)) {
    event.respondWith(artwork(request, url.pathname.slice(artworkPath.length)));
    return;
  }
  if (serverPaths.some((prefix) => url.pathname.startsWith(prefix))) return;
  if (request.mode === "navigate") {
    event.respondWith(navigate(request));
    return;
  }
  if (shell.has(url.pathname)) event.respondWith(asset(request));
});
