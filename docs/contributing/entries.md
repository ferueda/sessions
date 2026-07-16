# Entry inventory

The public behavior is defined by the
[CLI contract](../reference/cli-contract.md#entry-inventory).

## Query flow

1. The domain validates and freezes shared session filters, exact entry filters,
   selection, page limit, and cursor. Defaults are `all` and 50; the maximum page
   is 200 entries.
2. SQLite selects compact entry coordinates through source, tracking, canonical
   session, and entry rows. It does not use FTS or reconstruct session documents.
3. `all` keeps every qualifying entry. `first` or `last` keeps the lowest or
   highest canonical ordinal per session after all filters are applied.
4. Origin qualifies through retained segments, including omitted content. An
   empty entry cannot match an origin. Tool name or namespace selects observed
   `tool-call` entries only.
5. After page selection, SQLite loads exact segment counts and at most one text
   preview per entry. An origin-filtered query previews only text with that
   origin; an omitted-only match has no preview.
6. One query-scoped lineage resolver returns the known retained root or
   `unknown` for each result session.
7. A next cursor binds the full query, library identity, writer generation, and
   offset. It is a continuation token, not a durable bookmark.

## Order and evidence

Every mode orders by binary source kind, source instance, native ID, then entry
ordinal. Entry timestamps never reorder evidence. A preview is at most 512 UTF-8
bytes and keeps the full text content hash. Counts distinguish text, omitted,
and text not shown in the single preview.

Root attribution is query evidence only. It does not enter canonical documents,
document digests, exports, filters, or ordering. Missing targets, uncertain
coverage, cycles, and conflicting roots remain `unknown`.

## Cost

The query scans matching entry coordinates in stable key order and hydrates text
only for the selected page. `first` and `last` use a per-session ordinal lookup
after filtering. Origin filters probe retained segment rows. Root resolution
reads retained lineage once per nonempty query and reuses results within it.

The current schema and indexes are sufficient for the measured generic corpus.
Any later durable index needs separate size and query evidence.

## Code and proof

- Admission and service: `src/domain/session-query.ts` and
  `src/application/list-session-entries.ts`
- Filters, selection, hydration, and roots:
  `src/infrastructure/sqlite/sqlite-session-entry-query.ts`
- Cursor encoding: `src/infrastructure/sqlite/query-cursor.ts`
- Contract and regressions: `test/contracts/session-query.contract.ts` and
  `test/infrastructure/sqlite-session-entry-query.test.ts`
- Repeatable measurement: `pnpm measure:entry-query`
