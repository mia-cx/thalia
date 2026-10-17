# Auth and users

## Identity

- OIDC links to an existing account only on a verified email claim from the configured issuer.
- Local accounts with argon2id password hashing.
- OIDC through Authentik, first-order: login button, account linking by email.
- Admins create users or send invite links. No self-signup. No third-party identity providers beyond OIDC.

## Sessions

- Opaque random tokens, stored hashed, one per device with client name, device name and last seen. Revocable from the admin.
- No expiry by default, because Infuse and Kodi expect that. Optional maximum age.
- API keys per integration. Arr webhooks carry a per-integration secret in the URL.

## Permissions and groups

- Access is decided by rules: an allow or deny of one Action by one user or Group on one object (the server, a Library, an Item or a Playlist). The most specific object in the Item's chain decides; on that object a user's rule beats their Groups' rules, and a deny wins between Groups. No rule means unset; an unset user rule follows the Groups. Admins bypass every check.
- Actions are a flat set: view, play, download, edit metadata, edit subtitles, plus server-only manage libraries, manage users, manage plugins, manage transcoding and manage server.
- A Group is a named set of users. Built-in: admins, with everything, and users, seeded with server view, play and download rules. Custom groups are admin-made.
- A user has groups and rules of their own. Per-user settings: bitrate cap, content-rating ceiling.

## Artwork

Artwork routes accept anonymous requests by default, because Findroid sends no token and UUIDs make enumeration impractical. A toggle requires auth.

## Transport

- Plain HTTP is accepted. Cookie security flags apply on HTTPS only.
- Proxy headers are trusted from configured addresses only.
- Login is rate-limited per address and account. No built-in ACME.

## Playback URLs

A video element and Safari's native HLS cannot send headers, so playback URLs carry a per-session playback token in the query string: signed, short-lived, scoped to one session and one Item, refreshed by the client before it expires. The same-origin web client uses a cookie instead. Artwork stays anonymous. The account token never appears in a URL.
