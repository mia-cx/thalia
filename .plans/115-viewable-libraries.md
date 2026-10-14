# #115 API: list the libraries the caller may view

## Summary

Give signed-in callers their viewable libraries for the browse sidebar.
Reuse `viewableLibraryIds` without changing its permission rules.

## Acceptance criteria

- [x] Viewers receive only allowed libraries, with id, name and medium.
- [x] Admins receive every library, ordered by medium and name.
- [x] Callers with no viewable libraries receive an empty array.
- [x] The browse shell uses `libraries.viewable`.
- [x] Library administration keeps its existing permission checks.

## TODOs

- [x] Add the authenticated API procedure, schema and focused contract tests.
- [x] Switch the browse loader, then run lint and check.
- [ ] Open the PR and address CI and bot review findings.

## Notes

- The brief exempts this data source change from screenshots.
- The router already mounts the full `libraryProcedures` object.
- The three new behavior tests fail with NOT_FOUND before implementation.
- The required four API suites pass: 33 tests, 166 assertions, zero failures.
- Root lint passes with the nine existing CSS warnings. Root check passes with
  zero errors and zero Svelte warnings.
