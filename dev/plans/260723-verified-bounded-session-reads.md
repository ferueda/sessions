# Stream complete proof for bounded session reads

## Goal

Reduce peak memory and object construction for bounded `show` and `export`
without weakening the proof attached to a digest-guarded read. The current path
loads every relation, entry, segment, locator, metadata object, and text value
into one `SessionDocument`, validates it, projects the complete public document,
and recomputes its digest before selecting at most 50 default entries or one
explicit range of at most 200 entries. A supplemental aggregate-only live
measurement found that one 56,706-entry retained session took about 2.1 seconds
to return one entry.

The new bounded path must still visit and validate the complete canonical row
sequence, recompute the existing `sha256-sessions-document-jcs-v1` digest, and
compare complete document metrics inside one immutable reader operation. With
nested entry/segment streaming, retained state is bounded by the selected entry
window, the bounded relation prefix, unique relation keys needed for duplicate
validation, and the largest decoded scalar or metadata object currently being
checked. Unselected segment text and objects are released individually.
Successful human, JSON, and JSONL output must remain byte-for-byte equal to the
current path.

This is an allocation and memory optimization, not a sublinear-I/O claim.
Unguarded and guarded reads keep the same failure precedence: stored corruption
fails closed; an absent identity remains `session-not-found`; a valid expected
digest mismatch precedes entry-bound failure; and a matching digest permits the
existing coordinate result.

## Changes

1. `src/domain/public-session-document.ts` and a focused new
   `src/domain/public-session-document-stream.ts` — add a closed, stateful public
   document digest writer for the existing schema and digest scheme. It must
   emit the exact RFC 8785 byte sequence produced by
   `digestPublicSessionDocument(projectPublicSessionDocument(document))` while
   consuming header fields, then nested `beginEntry`/`writeSegment`/`endEntry`
   events, then relations.
2. The stream state follows RFC 8785 UTF-16 property-key order exactly:
   optional `createdAt`, `documentSchema`, `entries`, `lineageCoverage`,
   `relations`, optional `title`, optional `updatedAt`. Entries and their
   segments are therefore visited before relations. Refactor the existing
   private `projectEntry` and `projectContentSegment` into shared closed
   projection helpers, and use `writeCanonicalJson` for projected keys,
   scalars, and complete leaf objects; do not independently implement JSON
   string escaping or follow JavaScript insertion order in SQLite code.
3. The writer enforces contiguous ordinals, valid nested state transitions,
   declared counts, and one finalization. It exposes only the final
   `SessionDocumentDigest`, never intermediate transcript fragments.
   Differential domain tests cover empty documents, every optional field, every
   segment variant, control characters, non-BMP Unicode, the exact top-level
   key order, mixed relation/entry counts, and invalid call order.
4. Add `src/domain/session-document-stream.ts` as the provider-neutral
   incremental validation and metrics owner. Refactor reusable scalar and
   canonical-field checks from `src/domain/session-validation.ts` rather than
   maintaining a second interpretation of timestamps, identities, relations,
   tool fields, source locators, source metadata, content hashes, and omitted
   segments. Give it the stored entry count, validate related-entry bounds
   without retaining prior entries, keep only the relation duplicate-key set
   plus count/byte accumulators, and produce `SessionDocumentMetrics` at
   completion. It accepts nested entry/segment events so one unselected
   high-segment entry is not accumulated. Existing provider admission remains
   on `validateSessionDocument`; generated differential tests prove both
   validators accept the same valid documents and every stable stored-corruption
   fixture still fails closed.
5. `src/application/ports/session-index.ts` — add a focused
   `SessionSelectionReader extends SessionIndexReader` capability with one
   read-only `getSessionSelection` operation. Change only
   `src/application/ports/index-lifecycle.ts:IndexReader.sessions` to the
   extended capability; keep `SessionIndexWriter` extending the unchanged base
   reader so indexing implementations and writer fakes do not acquire a
   presentation-oriented method.
6. The selection request carries a non-negative relation limit and inclusive
   `fromEntry`/`toEntry` coordinates; it never converts them to a half-open end
   before the verified entry count is known. Values up to
   `Number.MAX_SAFE_INTEGER` remain admitted. The result carries verified public
   header fields, selected canonical relations and entries, complete document
   metrics, verified canonical digest, and a verified half-open actual window
   `{start,end}`. Compute it only after the total is known:
   `start = min(fromEntry,total)`; if `toEntry >= total`, use `end = total`,
   otherwise use `end = toEntry + 1`. Empty intersections are `{0,0}` or
   `{total,total}`. A coordinate beyond the document remains admitted so the
   application can preserve
   digest-mismatch-before-coordinate precedence. Keep `getSession` unchanged for
   full export, writer replacement assertions, and complete-document callers.
7. `src/infrastructure/sqlite/sqlite-session-document.ts` — implement
   `readCanonicalDocumentSelection` with ordered `StatementSync.iterate()` scans
   restricted to one `session_id`. Visit entries and segments first, then
   relations, matching the top-level canonical key order. Validate and hash
   every canonical row exactly once and retain only relations below the limit
   and entries intersecting the requested inclusive coordinates.
8. Refactor the existing SQLite-specific decoders in that file—stored integer
   and ordinal handling, relation and entry headers, nullable variant columns,
   metadata JSON, segment/content row shape, and content digest/text checks—into
   shared row-level helpers used by both
   `readCanonicalDocumentRecord` and the new selection reader. Sharing only
   domain scalar validators is insufficient. Unselected locators, metadata, and
   text are still parsed, type-checked, hash-checked, counted, hashed into the
   public document when applicable, and released.
9. Reuse `iterator-cleanup.ts` so success, corruption, digest mismatch, and
   SQLite failure close every iterator without masking the primary error. Add an
   optional internal selection-work observer, excluded from the application
   port, that reports only visited rows and current/maximum retained entry,
   segment, relation, and scalar-object counts. Wrap every notification and
   swallow observer exceptions; a throwing observer must produce the same
   successful result or canonical failure as no observer.
10. In the same SQLite owner, decode stored digest and metrics before scanning
    but trust neither as proof. Return only after the streamed digest equals the
    stored digest and every accumulated metric equals the stored row. Missing
    metrics, noncontiguous rows, orphan segment coordinates, malformed metadata,
    invalid variants/references, and digest or metric disagreement remain
    `corrupt-data`.
11. Add the capability through
    `src/infrastructure/sqlite/sqlite-session-index.ts` and immutable composition
    in `src/infrastructure/sqlite/database.ts`. Implement
    `getSessionSelection` with the existing `getSession` proof sequence: resolve
    tracking, stream and verify the canonical selection, read the summary,
    compare the verified canonical digest with `summary.documentDigest`, and
    only then return. Keep `getSession` unchanged. Before/after snapshot and
    sidecar checks remain unchanged.
12. `src/application/session-presentation.ts` — extract a selection-based
    presentation function that accepts verified public header fields, selected
    relations and entries, complete relation/entry totals, and the actual entry
    window. Preserve every current title, relation, entry, segment, per-segment
    text, aggregate text, omitted-content, and truncation calculation.
    `selectSessionTranscript` remains the full-document compatibility wrapper so
    full export and existing callers do not fork presentation semantics.
13. `src/application/show-session.ts`,
    `src/application/export-session.ts`, and
    `src/application/guard-session-document.ts` — route bounded modes through
    the selection capability and generalize `requireExpectedSession` over any
    verified result containing a summary; do not duplicate guard logic.
    Default bounded reads ask for inclusive coordinates
    `0..MAX_SELECTED_ENTRIES - 1`; focused show computes its requested context
    with a saturating safe upper coordinate; explicit ranges pass their admitted
    inclusive values without `toEntry + 1`. Compare the optional expected digest
    only after repository and summary verification, then call the existing
    coordinate resolver against the verified total. `export --full` continues
    through `getSession`.
14. Add a focused selection-reader contract rather than extending the writer
    contract. Extend
    `test/infrastructure/sqlite-session-index.test.ts`,
    `test/infrastructure/sqlite-reader-lifecycle.test.ts`,
    `test/contracts/provider-workflow.contract.ts`,
    `test/application/guarded-session-read.test.ts`,
    `test/application/show-session.test.ts`,
    `test/application/export-session.test.ts`, `test/cli-render.test.ts`, and
    `test/cli-structured-output.test.ts`. Pass old full-document and new
    selection results through the same human and JSON/JSONL render/encode
    functions and compare exact strings.
15. Mechanically update the immutable reader fixtures in
    `test/application/list-sessions.test.ts`,
    `test/application/list-session-entries.test.ts`,
    `test/application/search-sessions.test.ts`, and
    `test/application/create-session-manifest.test.ts` to use
    `SessionSelectionReader` or a shared reader fixture. Do not add the selection
    operation to writer fixtures.
16. Cover empty/short documents, default bounds, focus at both ends, the
    200-entry range maximum, maximum context, `Number.MAX_SAFE_INTEGER`
    coordinates, a request beyond the end, matching/mismatching/unguarded reads,
    attribution-only changes, relations above the display limit, one unselected
    entry with many segments, and every stored-corruption class. Combined-failure
    assertions require canonical corruption before expected-digest mismatch,
    missing identity before mismatch, valid mismatch before entry absence, and
    summary corruption as `corrupt-data`.
17. Add `scripts/measure-session-read.ts`, a
    `measure:session-read` package script, a small script-contract test, and the
    aggregate contract in `docs/contributing/testing.md`. Generate one canonical
    session at 100, 10,000, and 50,000 entries with controlled text bytes and
    compare complete-document selection with streamed selection for one entry and
    a 200-entry range. Pre-seed one closed generic database, then run baseline and
    streamed reads sequentially in separate child processes so seeding and the
    other strategy do not pollute peak RSS.
18. Report only generated counts, logical bytes, elapsed time, read-phase peak
    RSS, visited rows, maximum retained selected entries/segments/relation keys
    and current scalar objects, digest/metric equality, and output equality.
    Require exact equality and counters matching the stated retention model;
    keep elapsed time and RSS report-only.
19. Update `docs/architecture-memo.md`,
    `docs/contributing/architecture.md`, `docs/contributing/search.md`, and
    `docs/contributing/testing.md` when implementation lands. Label the path as
    complete streamed verification with bounded retention, state that SQLite
    I/O remains whole-document, and keep proof-addressable partial reads and
    streamed full export evidence-gated.

## Verify

- Run the focused public-digest stream, incremental validation, SQLite selection,
  guarded-read, show/export, structured-output, and measurement-contract tests.
- Run `pnpm measure:session-read` and require semantic/output equality plus the
  retained-object bounds; do not accept the change from elapsed time alone.
- Run `pnpm check`.

## Boundaries

- Do not add a migration, change the public document schema or digest scheme,
  trust stored digests or metrics, or weaken complete canonical validation.
- Do not add Merkle roots, per-entry digests, inclusion proofs, historical
  revisions, batch hydration, a package API, or provider reads. Those change the
  evidence contract and require a separate measured architecture plan.
- Do not stream partial JSON to stdout or change bounded-output fail-before-write
  behavior. Full export remains on the complete-document path.
- Stop and split the work if exact streamed RFC 8785 equality would require a
  second independently maintained projection; the field-by-field projection and
  digest owner must remain singular.
