---
status: accepted
date: 2026-10-13
---

# Access rules: subject, object, action, decided by the most specific object

Thalia's Permissions had three fixed slots: a Group's list of server-wide permissions, a per-user override of one permission, and a per-library allow or deny that only applied to viewing. That cannot express an account that sees a handful of shows, a library where some users browse but cannot download, or a person who curates one show's metadata. Thalia replaces all three with one shape, borrowed from Vesta: an Access rule allows or denies one Action on one object for one subject.

- **Subject**: a user or a Group.
- **Object**: the server, a Library, or an Item. An Item's chain runs up through its parent Items to its Library, then the server.
- **Action**: `view`, `play`, `download`, `metadata:edit`, `subtitles:edit` on any object; `libraries:manage`, `users:manage`, `plugins:manage`, `transcoding:manage`, `server:manage` on the server only.

No rule means unset. Thalia stores no unset rows; removing a rule unsets it.

## How a check is decided

Like CSS specificity, the most specific object decides:

1. Disabled users can do nothing. Built-in admins can do everything.
2. Walk the chain from the object itself up to the server. The first object holding a rule for this Action, for the user or any of their Groups, decides.
3. On that object, the user's own rule beats their Groups' rules. Between Groups, deny wins.
4. If no object in the chain has a rule, the answer is no.

Every Action except `view` also needs `view` on the same object. A user who cannot see an Item cannot play it.

A Library or Item the user cannot view still appears when browsing if it contains an Item they can view, listing only what they can see. That is how a restricted account reaches the shows it was given. Only its title and artwork show; its other Actions follow its own rules.

## Alternatives

- **Subject first, as Vesta does**: any user rule beats any Group rule, wherever each sits. A user denied a Library could then not be given one show in it through a Group, and a Group denied a Library could not be given back a single show. Object specificity is the order admins already know from CSS and Discord's channel overrides.
- **The facet in the object**, as in `item:subtitles`: subtitles have no id of their own, so this adds a second chain for every facet. The facet goes in the Action instead: `subtitles:edit` on `item:{id}`.
- **Keep the three slots and add an item slot**: each slot has its own precedence code, and the next request (per-library downloads, say) adds a fourth.

## Consequences

The migration turns Group permissions into Group rules on the server, overrides into user rules on the server, and library access rows into `view` rules on the Library, so every existing account keeps its access. One case changes: on a Library, a user allowed and a Group denied used to be denied, because any library deny won. Now the user's rule wins.

Most rules sit on the server and Libraries. Item rules are for the few restricted accounts. A list query loads the caller's rules once and filters in SQL, walking the parent chain with a recursive query. Nothing checks Items one at a time. Thalia adds a closure table only if that query measures slow.

Only built-in admins write rules. `users:manage` covers accounts, sessions and invites, not access.

The Jellyfin translation layer maps its policy onto rules: `EnableAllFolders` and `EnabledFolders` become user `view` rules on Libraries, and `EnableMediaPlayback` and `EnableContentDownloading` become user rules on the server. Item rules have no Jellyfin equivalent. Jellyfin apps see them only as Items missing from lists, and as refusals.
