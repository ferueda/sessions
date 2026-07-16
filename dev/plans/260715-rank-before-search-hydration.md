# Rank before search hydration

## Goal

Reduce broad first-page search time without changing any public result. The
current SQLite query carries full canonical text and digest values and runs FTS
`snippet()` for every matching occurrence before window ranking and pagination.
It also scans every retained text to prove its snippet markers do not collide.

The replacement must preserve byte-for-byte structured output for an unchanged
library and query: exact filters, BM25 and tie ordering, entry grouping, selected
segment, support counts, snippets, truncation, hashes, linked context, cursors,
and corruption handling. Performance is accepted only after the existing query
contract, new collision cases, and before/after live output comparisons agree.

## Changes

1. `src/infrastructure/sqlite/sqlite-session-query.ts:readSearchRows` — split
   first-page work into compact ranking and bounded hydration inside the same
   immutable snapshot. The ranking statement keeps only coordinates, identity,
   activity, `content_id`, score, and matching-segment count; it preserves the
   current filters, window rules, stable order, `LIMIT ? OFFSET ?`, and the extra
   unhydrated row used to decide whether a cursor exists. Hydrate only the page's
   selected rows through exact canonical keys, preferably in one bounded query,
   and compute each selected content snippet at most once per query. Fail closed
   if a selected coordinate, content row, FTS match, or hydrated row is missing,
   duplicated, or inconsistent. Keep full text/hash validation and context
   loading where they are observable today.

2. `src/infrastructure/sqlite/sqlite-session-query.ts:createSnippetMarkers` —
   remove the whole-library `instr(text, ...)` scan. Build the same private
   marker candidates from the library revision, validate them against every
   selected canonical text before parsing any snippet, and retry bounded
   hydration with the next candidate after a collision. An unchecked random
   marker is not acceptable. Empty pages do no marker or hydration work.

3. `test/infrastructure/sqlite-session-query.test.ts` and
   `test/infrastructure/sqlite-session-query.contract.test.ts` — retain the full
   current query contract and add focused regression cases for a selected text
   containing the first marker candidate, an unselected marker-like text, shared
   content across selected hits, more matches than the page limit, filtered
   searches, and pagination. Assert complete result equality across repeated
   queries, exact ordering/selected segments/additional-match counts, support,
   snippets/hashes/context, and next-cursor behavior. Use real in-memory SQLite
   and generic content; do not replace the repository with mocks.

4. `scripts/measure-search-query.ts`, `package.json`, and
   `docs/contributing/commands.md` — add an opt-in deterministic broad-search
   measurement outside `pnpm check`. Seed only generic temporary SQLite data
   through production storage seams, run a fixed broad first-page query, assert
   its exact expected order, counts, snippets, and repeated-result equality, and
   report only corpus size and aggregate elapsed time. Timing remains
   informational: correctness is a hard gate, milliseconds are not.

5. `docs/contributing/architecture.md`,
   `dev/plans/260713-v1-implementation-roadmap.md`, and `dev/plans/README.md` —
   record rank-first bounded hydration as completed M8 query hardening, keep
   support exact and query-wide, remove this completed executor plan, and leave
   bounded show/export ranges as the next feature.

## Verify

- Before source edits, run the current SQLite query/application tests and capture
  fixed read-only public JSON/JSONL searches from the retained library without
  printing or committing private output.
- After implementation, rerun the same tests and compare every captured public
  output byte-for-byte against the baseline before measuring speed.
- `pnpm test test/infrastructure/sqlite-session-query.test.ts test/infrastructure/sqlite-session-query.contract.test.ts test/application/search-sessions.test.ts`
- `pnpm measure:search-query`
- Repeat the aggregate-only live broad-search timing and phase measurement; report
  observed values without making them a correctness gate.
- `pnpm check`

## Boundaries

- No public CLI, DTO, ranking, filter, support, cursor, snippet, adapter, schema,
  privacy, or provider-access change.
- No approximate counts, result caps beyond existing limits, persistent caches,
  worker threads, new index, support-query consolidation, or deep-offset redesign.
- Stop if rank-first hydration cannot reproduce the exact baseline results; do
  not accept a faster query by weakening correctness or corruption checks.
