---
status: accepted
date: 2026-10-14
---

# Items belong to the server; Versions belong to Libraries

An Item was owned by one Library, so the same movie scanned twice became two Items: a WEB-DL at the top of a `[tmdbid-…]` folder and a Remux in a quality subfolder, or one copy in Movies and another in Kids. Each had its own progress, rating and metadata, although they are one film. Thalia now treats the Item as the film or episode itself, owned by the server, and the Version as the copy, owned by the Library whose root holds its Files.

- One provider id names at most one Item across the server. A scan, webhook or metadata match that finds a provider id another Item already holds adds its Files as a Version of that Item.
- An Item appears in every Library holding one of its Versions, or, for a show or season, one of its descendants' Versions. Browsing a Library lists those Items; an Item's page lists all its Versions.
- An Item with no Versions left, on itself or below it, is deleted.

Untagged files still find their Item by Item folder and title key within a root (ADR 0014) until a provider id is known. This supersedes ADR 0014's statement that `4K/Dune (2021)` and `HD/Dune (2021)` are two Items: once either carries the film's provider id, they are one.

## Access rules

This amends ADR 0015's chain. An Item's chain runs up through its parent Items to the server; Library rules reach it through its Versions:

1. If a rule for the Action exists on the Item or a parent Item, it decides, as before.
2. Otherwise each Version is decided by its Library, then the server. The user can act on the Item if they can act on any of its Versions, and sees only those Versions.

So a movie in Movies and Kids is visible to anyone allowed into either, through the copies in the Libraries they may open. To hide a film from someone regardless of where its copies live, put the rule on the Item.

## Jellyfin translation layer

Jellyfin's model has Library-owned items, and Infuse and the other clients depend on it. The translation layer therefore presents one Jellyfin item per Item and Library: its media sources are the Item's Versions in that Library only, and a show lists only the Seasons and Episodes with Versions in that Library. Its id is derived from the Item and the Library, so it is stable across scans. Progress, played, favourite and rating marks read and write the server Item, so watching a film through one Library marks it watched in the other. Thalia's own API and app use server-owned Items directly.

## Consequences

Two Items merge whenever a provider id lands on an Item while another already holds it, which happens in normal operation: an untagged copy is scanned before its metadata match resolves. The merge moves every Version and File to the surviving Item. Per-user state keeps the most recently updated progress and rating and keeps a favourite if either Item had one.

Per-Library settings that shaped an Item, such as its metadata language, now have to pick one Library when the Item sits in several. No database migration is provided: the only installed database is a development server, which is reset and rescanned.
