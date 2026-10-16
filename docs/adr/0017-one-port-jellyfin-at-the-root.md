---
status: accepted
date: 2026-10-14
---

# One port: Jellyfin at the root, Thalia under /api and /web

Thalia serves its API, its web app and the Jellyfin translation layer on one port. Jellyfin clients call top-level paths such as `/Items`, `/Shows` and `/Search`, matched without regard to case, and the web app's pages used the same names (`/movies`, `/shows`, `/search`). Every new page risked shadowing a Jellyfin route or being shadowed by one.

Thalia splits the port by prefix, the way Jellyfin itself does:

- `/api/*`: the Thalia API, REST and RPC (`/api/rpc/*`), plus auth, events, playback, artwork, subtitles, webhooks, watcher and plugin routes (`/api/ext/<plugin>/*`).
- `/web/*`: the Thalia web app. `/` redirects to `/web/`, as on a Jellyfin server.
- `/healthz` and `/readyz`: probes.
- Everything else: the Jellyfin layer and its websocket.

A second listener on Jellyfin's default port 8096 or a `/jellyfin` path prefix were the alternatives. A second port adds a setting and a published port to every deployment, and some Jellyfin clients handle a server address with a path badly; the root is where every Jellyfin client looks.

## Consequences

Thalia owns no top-level path outside `/api`, `/web` and the probes, so the Jellyfin layer can add any route Jellyfin documents. `/web` is the path Jellyfin serves jellyfin-web from; that client is out of scope (see the Jellyfin layer spec), so nothing expects Jellyfin's own web client there. Web app links, server redirects such as the login redirect, invite links and the service worker scope all move under `/web`. Plugin HTTP routes move from `/plugins/<name>/` to `/api/ext/<name>/`, because `/Plugins` is a Jellyfin route.
