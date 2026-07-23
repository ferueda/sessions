# Optimize everyday query hot paths without changing evidence semantics

## Goal

Make routine `list`, `entries`, and `search` reads scale with the requested page
wherever their contracts permit it. Query execution should select the smallest
deterministically ordered page of compact coordinates, batch-hydrate and verify
only that page, and calculate exact query-wide evidence once when support or
lineage requires it.

The current broad entry selector is the first priority. On an aggregate-only
live library with 4,544 sessions and 3.57 million entries, a 50-entry page took
roughly 4.5–6 seconds warm because SQLite scanned `sessions_entries` first and
built a temporary ordering B-tree before applying `LIMIT`. An equivalent
source→tracking→canonical→entry traversal used existing indexes, required no
temporary sort, and selected 51 coordinates in about 0.1 milliseconds warm.
The existing generated measure uses only five entries per session and does not
expose this skew.

Search is the second priority. It currently scans overlapping FTS results for
aggregate support, distinct matching identities, and ranking, then performs
point reads for selected snippets, contexts, and summaries. Exact support and
ranking inspect the complete qualifying result by design, so broad search
cannot become page-only work; the target is one query-wide match computation
plus bounded page hydration, not approximate evidence.

Every delivery slice below is independently reviewable and lands in order.
Acceptance requires deep-equal repository results, byte-identical structured
output except for the intentionally versioned opaque cursor token in slice 7,
unchanged cursor field presence and continuation results, unchanged capture
scope, support, ranking, roots, corruption handling, snapshot behavior, and
cursor failures, plus deterministic work-shape or repeatable aggregate
measurements. Machine time is never the sole correctness gate.

## Changes

### 1. Bound entry coordinate selection

1. `src/infrastructure/sqlite/sqlite-session-entry-query.ts:readEntryRows` —
   make source→tracking→canonical→entry traversal explicit with order-preserving
   `CROSS JOIN` boundaries and the existing equality predicates. Preserve every
   `entryInventoryWhere` filter, the filtered `first|last` subquery from
   `selectionClause`, binary source/instance/native ordering, ascending entry
   ordinal, `LIMIT + 1`, and cursor behavior. Keep hydration after page slicing
   and use the existing unique and primary-key indexes; this slice adds no
   migration or durable index.
2. `test/contracts/session-query.contract.ts` — traverse every entry page in
   `all`, `first`, and `last` modes and compare the concatenated result with the
   one-page canonical result. Cover source, instance, native ID, source state,
   workspace, activity, entry time, actor, origin, kind, and tool filters;
   binary-order identity edges; roots; content counts and previews; capture
   scope; cursor mismatch; and cursor staleness.
3. `test/infrastructure/sqlite-session-entry-query.test.ts` — isolate plan-shape
   risks that the shared contract does not: selected versus unselected corrupt
   rows, each filter family under the explicit traversal, and `first|last`
   applying entry filters inside the per-session selection rather than after
   ordinal selection.
4. `scripts/measure-entry-query.ts` — replace or supplement the uniform profile
   with an owned on-disk corpus containing thousands of sessions, hundreds of
   thousands of entries, and at least one session with tens of thousands of
   entries. Use mostly textless entries plus bounded shared text so coordinate
   work dominates. Measure broad and filtered `all`, `first`, `last`, origin,
   tool, early-page, and deep-page cases after a warm-up; report seeding,
   coordinate selection, full hydration, aggregate counts, and repeated
   semantic equality separately.
5. Add a private, best-effort timing/work observer around `readEntryRows` and
   `hydrateEntries`, accepted only by the infrastructure entry-query function
   and composed only by the generated measure. Observer failure must not change
   query behavior or public output. Factor the exact production coordinate SQL
   into one focused internal builder so the measure can run
   `EXPLAIN QUERY PLAN` against the statement that ships rather than a copied
   query.
6. The measure records normalized plan facts: outer scan, indexes used, and
   temporary ordering B-tree presence. These are diagnostics, not Vitest
   assertions tied to one SQLite version. Promote the SQL change only when the
   generated result is identical and the broad plan avoids the entry-first full
   scan and full temporary sort on supported development runtimes.
7. Update `docs/contributing/entries.md` and
   `docs/contributing/testing.md` with the bounded-coordinate design, generated
   skew profile, structural proof, and report-only elapsed evidence.

### 2. Measure planner statistics as a separate complement

1. Add `scripts/measure-query-planner-statistics.ts` and an opt-in package
   command. Create equal generated databases from the skewed corpus, apply
   explicit `ANALYZE` and `PRAGMA optimize` variants only to experimental
   clones, and compare plans, alternating warm elapsed times, statistics rows,
   and database byte growth.
2. Cover broad and narrow entries after the explicit traversal, list identity
   and activity filters, broad and selective `all|any` search, and manifest
   selection. Record whether any benefit remains beyond the local query-shape
   fix and how often statistics would need refresh as the corpus changes.
3. Do not invoke planner-statistics commands from readers, migrations, index,
   doctor, or maintenance in this slice. If no repeatable benefit remains, if
   selective queries regress, or if refresh/storage cost is material, close the
   experiment without a runtime policy. If evidence justifies persistence,
   create a separate plan covering certified writer mutation, receipt sequence,
   recovery, refresh cadence, schema compatibility, and index-time cost.

### 3. Batch selected search content and snippets

1. `src/infrastructure/sqlite/sqlite-session-query.ts:hydrateSearchContent` —
   replace one execution per selected content ID with one page-bounded selected
   content CTE. Deduplicate IDs, retain the explicit integer FTS rowid
   restriction, and require exactly one canonical text, digest, and snippet per
   requested ID. Preserve full-text hash validation and marker-collision
   handling; if any selected text contains the candidate markers, retry the
   complete selected page with the next deterministic candidate. Unselected
   content must not influence marker selection.
2. `src/infrastructure/sqlite/sqlite-session-query.ts:hydrateSearchHits` —
   build the content map once and make snippet projection free of content point
   reads. Leave context, summary/root work, and `readMatchedTerms` unchanged in
   this slice; `any` mode is already bounded by selected coordinates and at most
   32 admitted terms.
3. Extend `test/infrastructure/sqlite-session-query.test.ts` with limits 1, 20,
   and maximum; shared/repeated content IDs; marker collisions; multibyte text;
   and empty bodies. Missing or duplicate selected content, FTS disagreement,
   malformed text, and digest mismatch must still fail the whole read, while an
   unselected corrupt row stays unhydrated.
4. Extend `scripts/measure-search-query.ts` with page-size profiles,
   selected-content counts, statement counts, and alternating warm elapsed
   time. Update `docs/contributing/search.md` and
   `docs/contributing/architecture.md` to claim only batched selected-page
   content/snippet hydration.

### 4. Batch selected search context

1. `src/infrastructure/sqlite/sqlite-query-context.ts` — replace per-hit
   `readSearchContext` calls with a page operation keyed by each selected
   `(sessionId, primaryOrdinal)`. One query reads direct tool-call/result
   coordinates for all primaries and retains enough ordered candidates to prove
   `linkedContextTruncated`.
2. Keep a separate per-primary membership map containing each selected physical
   coordinate and its adjacent/linked flags. Deduplicate SQL hydration by
   physical `(sessionId,entryOrdinal)`, then read those unique coordinates and
   ordered text segments in fixed chunks below SQLite's minimum supported
   bind-variable limit. Merge chunk results into the per-primary map
   deterministically, preserving direct-link-only expansion, ordinal order,
   linked caps, flags, and 512-byte UTF-8 body truncation. Query work is one
   primary-coordinate query plus
   `ceil(unique physical context coordinates / chunk limit)` hydration queries,
   not an infeasible fixed two-query claim.
3. `src/infrastructure/sqlite/sqlite-session-query.ts:hydrateSearchHits` — build
   the context map once and remove per-hit context point reads, leaving the
   content map from slice 3 and separately owned summary/root work unchanged.
4. Extend `test/infrastructure/sqlite-session-query.test.ts` with context 0 and
   maximum at the maximum result limit; enough adjacent/linked coordinates to
   cross several chunks; links in both directions; linked overflow;
   adjacent/linked overlap; multibyte truncation; empty bodies; multiple hits in
   one session; and corruption/failure in a later chunk. Require exact output
   equality and all-or-nothing failure.
5. Extend the search measure with selected-context counts, expected/actual chunk
   counts, and alternating warm elapsed time. Document chunked selected-page
   context hydration without claiming query-wide bounded search work.

### 5. Prototype one query-wide search match set

1. In an isolated change, prototype one
   `WITH matching_segments AS MATERIALIZED` statement derived from the current
   literal FTS query, joins, and exact filters. It emits tagged result sections
   for aggregate occurrences/distinct content, distinct matching identities
   needed for root support, and the ranked `LIMIT + 1` coordinate page using the
   current BM25, activity, binary identity, and ordinal order. It creates no
   durable or transcript-bearing table and never derives query-wide support from
   the visible page.
2. Factor only shared joins and filter parameters needed to compare baseline and
   prototype; do not add a general SQL builder. Root resolution continues over
   the complete matching identity set and page hydration uses slice 3.
3. Add a dedicated measure or extend `measure:search-query` to alternate
   baseline and prototype over selective/broad terms, `all|any`, repeated
   occurrences with low unique content, many identities and lineage states,
   limits 1/20/maximum, and first/deep pages. Report qualifying FTS traversals,
   match-set time, hydration time, total time, and peak RSS.
4. Run both strategies against the same generated fixtures in
   `test/infrastructure/sqlite-session-query.test.ts` and
   `test/contracts/session-query.contract.ts`; require deep equality of hits,
   support, roots, snippets, matched terms, context, capture scope, and cursors.
5. Define “one qualifying FTS traversal” structurally as one normalized
   `EXPLAIN QUERY PLAN` virtual-table `MATCH` scan and one execution of the
   match-set statement; Node's SQLite API does not expose a reliable FTS row
   traversal counter. Promote only if the shape is legal for FTS5/BM25, meets
   that structural proof, repeatedly improves broad search by roughly 20% or
   more, keeps selective regression within 10%, and keeps peak RSS growth within
   25% in the alternating generated measure. These are prototype decision
   thresholds, not CI budgets. If the gate fails, remove the production
   prototype and retain the exact multi-scan path plus the independently useful
   page batching.

### 6. Batch selected summaries

1. `src/infrastructure/sqlite/sqlite-session-state.ts` — add a bounded
   `readSessionSummariesBatch` keyed by canonical session ID and expected
   identity. Bind only `(sessionId,kind,instanceId,nativeId)` for each distinct
   selected session: at the 200-row public maximum this is 800 variables, below
   SQLite's minimum supported limit. Join canonical, tracking, and source rows
   once, validate one result per requested session, and restore page order in
   JavaScript from the validated session-ID map rather than binding an input
   ordinal. Reuse the existing freshness and retained summary decoders; reject
   missing, duplicate, malformed, or identity-inconsistent rows as
   `corrupt-data`. Refactor shared decoding so point and batch reads cannot
   drift.
2. `src/infrastructure/sqlite/sqlite-session-query.ts:listSessions` — carry the
   compact session ID through the ordered page and batch selected summaries
   after slicing. Do not enlarge the pre-limit sort with summary payload.
3. `src/infrastructure/sqlite/sqlite-session-entry-query.ts:hydrateEntries` and
   `src/infrastructure/sqlite/sqlite-session-query.ts:hydrateSearchHits` —
   deduplicate selected session IDs and replace per-session summary cache misses
   with one bounded batch.
4. Add corruption-parity tests and SQLite authorization/work-shape assertions
   comparing page size 1 with maximum. The number of summary SELECT
   authorizations must remain constant per page rather than grow with distinct
   selected sessions. Extend entry/search measures with distinct-session
   profiles.

### 7. Add compatible keyset continuation for list and entries

1. `src/infrastructure/sqlite/query-cursor.ts` — add cursor v2 while retaining
   command, complete query fingerprint, random library instance, writer
   generation, and cumulative next offset. Add bounded provider-neutral numeric
   anchors: canonical `session_id` for list and
   `(session_id,entry_ordinal)` for entries. Do not place raw source instance or
   native IDs in the opaque base64url token. Preserve canonical encoding, the
   2,048-byte bound, allowlisted payload shape, usage-versus-stale failures, and
   opacity.
2. Decode existing v1 cursors for all commands. New list/entries continuations
   emit v2; search continues to emit and consume the existing offset-only v1
   format. A v1 list/entries page uses the current offset path once, then emits
   v2 from its last returned row. New v2 list/entry pages use the numeric anchor
   while retaining cumulative offset for the existing internal contract.
3. `src/infrastructure/sqlite/sqlite-session-entry-query.ts` — add a strict
   anchor-resolution CTE that requires the numeric coordinate to exist and
   qualify under the same entry filter and `first|last` selection, recovers its
   binary source/instance/native order fields, and applies the lexicographic
   after-anchor predicate. `src/infrastructure/sqlite/sqlite-session-query.ts`
   does the same for list: coordinate selection carries `canonical.session_id`
   and validated effective activity, and anchor resolution recovers null-last
   activity plus the binary identity ties inside the same immutable snapshot.
   Revision mismatch is `stale-cursor`; a structurally malformed v2 payload or
   matching-revision anchor that is absent/non-qualifying is `invalid-cursor`;
   an existing anchor row with malformed stored fields is `corrupt-data`. Emit
   an anchor only when the extra row proves another page.
4. Extend `test/infrastructure/sqlite-query-primitives.test.ts` for v1/v2
   admission and failure cases. Extend the shared query contract to traverse
   page size one across equal and null activity, binary Unicode identities,
   every entry selection/filter family, a v1-to-v2 transition, recreated
   libraries, and later writer generations. Concatenated keyset traversal must
   equal canonical one-page results with no gaps or duplicates.
5. Extend generated measures with early and deep pages. The structural gate is
   production v2 SQL with no `OFFSET`, an anchor-resolution CTE, a strict
   after-anchor predicate, and normalized `EXPLAIN QUERY PLAN` evidence of
   indexed continuation; deep-page elapsed time is supplemental. Update
   architecture, entry, and search docs; the public syntax, cursor opacity,
   mismatch rules, and stale rules remain unchanged.

### 8. Measure and, only then, lazy-load CLI composition

1. After slices 1, 3, 4, 6, and 7 land and the search prototype is closed, add
   `scripts/measure-cli-startup.ts`. Against compiled `dist` and generated
   temporary state, alternate bare Node, version, top-level help, command help,
   and one provider-free read; report median/p95 aggregates without touching
   contributor providers or the ordinary library.
2. If the compiled evidence is material, refactor `src/bin/sessions.ts` to use
   type-only imports plus memoized dynamic imports inside the command callbacks
   that need concrete providers, lifecycle, maintenance, or application
   services. Keep provider kinds available for grammar/help and preserve the
   composition-root rule that only `src/bin/` selects concrete adapters.
3. `test/cli.test.ts`, `pnpm smoke:dist`, and `pnpm smoke:package` must preserve
   exact grammar, help, output, errors, signals, provider laziness, and packaged
   module resolution. If callback-level imports do not materially reduce
   packaged startup, stop without splitting `program.ts` or adding a custom
   dispatcher.

## Verify

- Run the focused shared query contract, SQLite entry/search, cursor primitive,
  CLI, and applicable measurement-contract tests after their owning slice.
- Run `pnpm measure:entry-query` and `pnpm measure:search-query`; run experimental
  planner, search-materialization, and startup measures only in their slices.
- Run `pnpm typecheck`, `pnpm deps:check`, and `pnpm check` before publishing
  each independently reviewable slice.

## Boundaries

- Do not change human, JSON, or JSONL fields, order, limits, byte bounds, exit
  codes, or fail-before-output behavior.
- Do not approximate support, rank, matched terms, snippets, context, capture
  scope, or lineage, and do not hydrate transcript text before page selection.
- Do not add a daemon, cross-process cache, package API, batch command, network,
  telemetry, or provider-specific query behavior.
- Do not add durable indexes or migrations in the primary query slices.
  Planner statistics remain experimental until separately justified.
- Do not fold full-document reads, manifest copying, doctor, or lineage-closure
  work into this program.
- Do not place contributor paths, identities, transcripts, or private corpus
  details in plans, fixtures, docs, or measurement output.
