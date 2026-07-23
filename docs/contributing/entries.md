# Entry inventory

The public behavior is defined by the
[CLI contract](../reference/cli-contract.md#entry-inventory).

## Query flow

1. The domain validates and freezes shared session filters, exact entry filters,
   selection, page limit, and cursor. Defaults are `all` and 50; the maximum page
   is 200 entries.
2. SQLite selects compact entry coordinates through an explicit
   source→tracking→canonical→entry traversal. `CROSS JOIN` boundaries keep that
   loop order stable so SQLite can stop after the requested page instead of
   scanning the entry table and sorting the complete result. It does not use FTS
   or reconstruct session documents.
3. `all` keeps every qualifying entry. `first` or `last` keeps the lowest or
   highest canonical ordinal per session after all filters are applied.
4. Origin qualifies through retained segments, including omitted content. An
   empty entry cannot match an origin. Tool name or namespace selects observed
   `tool-call` entries only.
5. After page selection, SQLite loads exact segment counts and at most one text
   preview per entry. It deduplicates selected sessions and loads their retained
   summaries in one identity-checked batch of at most 200 requests. An
   origin-filtered query previews only text with that origin; an omitted-only
   match has no preview.
6. The same immutable snapshot supplies one page-level capture scope from
   registered sources and tracking state. Entry and canonical metadata filters
   are named as unassessed for tracking-only sessions.
7. One query-scoped lineage resolver returns the known retained root or
   `unknown` for each result session.
8. A next cursor binds the full query, library identity, writer generation,
   cumulative offset, and the last selected numeric session/entry coordinate.
   Continued pages strictly resolve that coordinate under the same filters and
   selection, recover its binary identity order, and continue after it without
   `OFFSET`. The token contains no raw provider identity.
9. Existing v1 offset cursors remain accepted. They use the offset path once and
   emit a v2 anchored continuation. A missing or nonqualifying matching-revision
   anchor is invalid; a different library or writer generation is stale. Cursors
   remain opaque continuation tokens, not durable bookmarks.

## Order and evidence

Every mode orders by binary source kind, source instance, native ID, then entry
ordinal. Entry timestamps never reorder evidence. A preview is at most 512 UTF-8
bytes and keeps the full text content hash. Counts distinguish text, omitted,
and text not shown in the single preview.

Root attribution is query evidence only. It does not enter canonical documents,
document digests, exports, filters, or ordering. Missing targets, uncertain
coverage, cycles, and conflicting roots remain `unknown`.

Capture scope is separate evidence-availability context. It cannot classify an
unindexed session against an entry, actor, origin, tool, time, workspace, or
other canonical-only filter, and it never turns a tracking row into an entry
match or non-match.

## Cost

The query walks matching entry coordinates in stable source and identity index
order, stops after `limit + 1`, and hydrates text only for the selected page.
`first` and `last` use a per-session ordinal lookup after filtering. Origin
filters probe retained segment rows. Root resolution reads retained lineage once
per nonempty query and reuses results within it.

The generated measure uses an on-disk skewed corpus with thousands of sessions,
hundreds of thousands of mostly textless entries, and one session with tens of
thousands of entries. It warms and repeats broad and filtered `all`, `first`,
`last`, origin, tool, early-page, and deep-page reads. The report separates
coordinate selection from full hydration, proves repeated result equality, and
normalizes `EXPLAIN QUERY PLAN` into the outer access, indexes used, and
temporary-ordering presence. It also reports whether the production statement
uses keyset continuation or `OFFSET`; new and v2 entry pages must have no
`OFFSET`. Elapsed time is report-only; semantic equality and the
source-first/no-full-sort bounded plan shape are the structural proof.

The current schema and indexes are sufficient for this traversal. Any later
durable index needs separate size and query evidence.

## Code and proof

- Admission and service: `src/domain/session-query.ts` and
  `src/application/list-session-entries.ts`
- Filters, selection, hydration, and roots:
  `src/infrastructure/sqlite/sqlite-session-entry-query.ts`
- Cursor encoding: `src/infrastructure/sqlite/query-cursor.ts`
- Contract and regressions: `test/contracts/session-query.contract.ts` and
  `test/infrastructure/sqlite-session-entry-query.test.ts`
- Repeatable measurement: `pnpm measure:entry-query`
