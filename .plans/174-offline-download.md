# #174 Offline: download a movie or episode into browser storage

## Summary
A user with `download` can save a movie or episode's original file into the browser's Origin Private File System, watch its progress, pause, resume, cancel and delete it, and see how much space downloads use. Offline playback and the rest of PRD #173 are later slices.

## Acceptance criteria
- [ ] `GET /api/items/{itemId}/versions/{versionId}/download` serves the original file to a session cookie, after the origin check and `download` on the Item's Library, with Range support and `content-disposition: attachment`.
- [ ] 403 without `download`, 404 for a Version of another Item.
- [ ] Movie and episode pages show Download only when the caller has `download`.
- [ ] Downloads stream into OPFS, resume with Range, restart on 200, and survive a reload as paused.
- [ ] A Downloads page in the main navigation lists downloads with progress, size, pause, resume, cancel and delete, plus usage and space left.
- [ ] Persistent storage is requested before the first download; a refusal shows on the Downloads page.
- [ ] The service worker still caches no media or API responses.

## TODOs
- [x] Server: first-party download route with tests.
- [x] Server: item detail carries `canDownload` and each Version's container and streams, with tests.
- [x] Web: `lib/downloads` store over OPFS with unit tests.
- [x] Web: Download button on movie and episode pages.
- [x] Web: Downloads page and navigation entry.
- [ ] Browser test: download through the button, reload mid-way, compare bytes.
- [ ] Screenshots, lint, check.

## Notes
- The web app has no per-Library permission data (`me.admin` only), so the item detail gains `canDownload`, computed like the Jellyfin layer's `CanDownload`.
- The store records need the Version's container and streams, which the detail did not carry; they are added to the detail's versions.
- OPFS writable streams write to a swap file that only lands on close. The store commits (closes and reopens with `keepExistingData`) each time the bytes written since the last commit reach the size already committed, from 64 MiB up. A reload loses at most half the progress, and the copying that reopening costs stays near one file size in total.
