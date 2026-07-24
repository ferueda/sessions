# Prove a single-pass doctor FTS comparison before changing production

## Goal

Determine whether exact doctor FTS instance comparison can use one monotonic
actual stream and one monotonic expected stream instead of retained term ranges
plus repeated bidirectional `EXCEPT` queries.

The accepted
[document-interval feasibility result](../../docs/research/doctor-document-interval-feasibility.md)
rejected document-ID-bounded actual-vocabulary scans because 41
production-shaped intervals made dominant work 3.80 times slower. The current
production path in
`src/infrastructure/sqlite/fts-projection.ts:ftsProjectionSemanticContentIsValidReadOnly`
still builds one complete, corpus-sized, memory-only expected FTS projection,
streams actual and expected row vocabularies into a retained
`DoctorTermRange[]`, then runs two instance `EXCEPT` queries per range.

This plan is an evidence gate, not a production executor plan. Its candidate
keeps the complete expected projection and existing exact docsize proof, so it
may reduce comparison CPU and make comparison-side state constant but cannot
claim bounded total memory. Production doctor remains unchanged until generated
evidence passes, the reliance on FTS5 vocabulary order is explicitly accepted,
and a separate production plan is approved.

## Changes

1. Extend `scripts/measure-doctor.ts` with a separate single-pass controller
   mode, exposed as `pnpm measure:doctor:single-pass` in `package.json`. Reuse
   the existing generated production-writer corpora, owned temporary root,
   controller-issued worker authority, immutable clones, fresh child processes,
   alternating strategy order, aggregate-only report, and success/failure
   cleanup. Add full-only generated cohorts for a mixed ordinary-term index
   whose current algorithm reports at least three production-sized term ranges
   and for one repeated term above the 1,000,000-instance target. Keep the
   existing `pnpm measure:doctor` arguments, corpora, and exact report unchanged.
2. Put candidate query and comparison code in a controller-independent
   `scripts/doctor-single-pass-probe.ts` whose effects are limited to
   connection-local memory-only TEMP state with complete cleanup. The controller
   and deterministic tests must use this one measurement-only implementation.
   Compare byte-identical clones with three strategies:
   - the current production
     `ftsProjectionSemanticContentIsValidReadOnly` result and total elapsed
     time;
   - a term-ordered direct-stream candidate; and
   - a fully ordered
     `ORDER BY term COLLATE BINARY, doc, col COLLATE BINARY, offset` control
     that reveals the cost and TEMP plan of portable explicit ordering.
     The candidate and control must build the same complete expected TEMP FTS and
     perform the same bidirectional docsize proof before instance comparison.
3. For the candidate, prepare one actual and one expected
   `fts5vocab(..., 'instance')` iterator ordered only by
   `term COLLATE BINARY`. Decode SQLite integers as `bigint`. Validate every
   coordinate as a non-empty term, signed 64-bit document ID, exact `text`
   column, and non-negative signed-64-bit offset. Require each stream to be
   strictly increasing by UTF-8 binary term, signed document ID, binary column,
   then offset. Compare coordinates one-for-one and require both iterators to
   reach EOF together. A malformed, duplicate, non-monotonic, unequal, missing,
   or extra row fails closed.
4. Retain only the current and previous coordinate from each stream. Close both
   iterators through the existing
   `src/infrastructure/sqlite/iterator-cleanup.ts:closeSqliteIterators`
   error-precedence pattern before dropping TEMP objects. Keep
   `PRAGMA temp_store = MEMORY`, require the read-back value `2`, preserve the
   private savepoint and any outer transaction, and make load, iteration,
   comparison, rollback, release, or drop failure unhealthy. No comparison
   term, range, document, position, count map, hash, or array may grow with the
   corpus.
5. Capture normalized `EXPLAIN QUERY PLAN` facts and exact operation counters
   for all strategies. Candidate admission requires exactly one actual and one
   expected instance-vocabulary scan, no `EXCEPT`, no grouped summary query, no
   TEMP B-tree, exact visited-row counts, and constant two-row lookahead.
   Explicit full ordering is a control, not an acceptable fallback if it
   materializes corpus-sized sort state. The real production baseline reports
   only total elapsed time; do not invent unavailable baseline phases or modify
   `src/` to expose them. Candidate and control phases are expected-index load,
   docsize, instance comparison, cleanup, and total. Peak RSS remains supporting
   evidence rather than a threshold.
6. Add `test/doctor-single-pass-measurement.test.ts` with two distinct proofs:
   - import the measurement-only probe and require the same healthy/unhealthy
     decisions as the current complete-vocabulary oracle for empty projections,
     zero-token rows, sparse signed IDs including integer extrema, multibyte and
     canonically distinct Unicode, missing or extra first/middle/final
     coordinates, equal-count wrong terms, shifted documents/columns/offsets,
     cross-document swaps, and docsize damage. Keep the routine contract corpus
     bounded and assert constant lookahead with a reduced repeated-term target;
     add a fixed-seed small-corpus matrix whose healthy and damaged cases must
     agree with the oracle; and
   - spawn the reduced controller contract and require recursive output
     allowlisting, exact aggregate derivation, fixed query/row counters,
     private modes, unchanged database bytes and metadata, absent WAL/SHM/
     journal artifacts, silent private-worker failure, and complete cleanup.
     Exercise different healthy FTS segment topologies on equal content so the
     monotonicity guard is not proved by one insertion shape.
7. Run the reduced ordering contract on the minimum supported Node runtime and
   the current release runtime. Record Node and SQLite versions. The
   [public `fts5vocab` contract](https://www.sqlite.org/fts5.html#the_fts5vocab_virtual_table_module)
   exposes instance coordinates but does not promise the complete native tuple
   order used by the candidate. A future runtime that changes that order must
   fail a healthy library closed through the monotonicity guard; a production
   plan may accept that compatibility dependency only through an explicit human
   decision.
8. Record the result in
   `docs/research/doctor-single-pass-fts-feasibility.md`. Require exact
   correctness, immutability, privacy, cleanup, and structural work assertions
   before interpreting time. The opt-in full measure must cover the existing
   large high-unique-term cohort, the mixed corpus with at least three observed
   baseline ranges, and the dominant repeated term crossing the current
   1,000,000-instance target. Run at least two complete invocations and report
   median and p95 total ratios per cohort plus candidate phase scaling. A
   candidate slower than the real production baseline in any named large cohort
   is rejected. Non-regressive but noise-sized or inconsistent gains are
   inconclusive, not acceptance. There is no automatic elapsed-time pass:
   explicit human review decides whether repeated gains are meaningful and
   whether the ordering dependency is acceptable before a separate production
   executor plan may be created.

## Verify

- `pnpm test test/doctor-single-pass-measurement.test.ts`
- `pnpm measure:doctor:single-pass`
- `pnpm check`

## Boundaries

- Do not change `src/` production doctor behavior, public health/CLI contracts,
  output, exit codes, provider reads, or persistent library state in this
  feasibility slice.
- Do not describe direct instance streaming as bounded total memory. The full
  expected TEMP FTS remains corpus-sized.
- Do not revive document-ID vocabulary scans, spill transcript-derived terms or
  coordinates to disk, reimplement `unicode61`, load a native extension, open
  the library writable for FTS5 `integrity-check`, sample evidence, or replace
  exact coordinates with counts or hashes.
- Stop if deterministic ordering needs a TEMP B-tree, either vocabulary is
  scanned more than once, comparison-side retained state grows with terms or
  instances, any corruption decision differs, a hard immutability/privacy
  assertion fails, or the candidate regresses any named large cohort. Treat
  noise-sized or inconsistent gains as inconclusive and keep the current audit.
