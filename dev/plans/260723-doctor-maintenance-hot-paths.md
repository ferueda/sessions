# Measure doctor and bound orphan maintenance without weakening integrity

## Goal

Keep Sessions' exact, fail-closed evidence contracts while measuring doctor and
bounding routine orphan maintenance.

The doctor feasibility slice is complete. Today
`ftsProjectionSemanticContentIsValidReadOnly` builds a second complete FTS5
projection from every retained canonical content value in memory, then compares
the complete expected and actual vocabularies. Its term ranges normally target
1,000,000 instances, but one term above that target is still compared as one
unbounded range. On a large retained library this duplicates a corpus-sized
search structure before useful progress is visible and is the most likely cause
of reports that doctor appears to hang. Human review accepted the measurement's
rejection of document-ID-bounded actual-vocabulary scans. Production doctor is
unchanged; successor investigation moved to
[the single-pass FTS feasibility plan](260723-doctor-single-pass-fts-feasibility.md).

The remaining executable scope is orphan repair. It currently pages all content
rows, tests reachability row by row, and executes a fenced zero-deletion batch
for windows containing only referenced content. The desired query should page
only orphan candidates while preserving the transaction-time reachability
recheck.

Carrying certified cleanliness through a successful compact is outside this
plan. Compaction deliberately invalidates the previous clean proof today. Any
investigation into carrying, but never manufacturing, cleanliness requires a
separately accepted measurement plan and ADR.

Doctor remains an immutable, exact whole-library audit. Repair remains
uncertified maintenance. The program changes no provider behavior, query
result, public command grammar, structured output, exit code, or retention
policy. The feasibility measure and orphan paging land as separate PRs. The
bounded doctor refactor in this program is retired; orphan paging remains
independently executable.

## Changes

### 1. Establish the doctor measurement and work contract

1. Add `scripts/measure-doctor.ts` and `measure:doctor` in `package.json`.
   Generate provider-free libraries through the production SQLite writer and
   run each measured cohort in a fresh child process so seeding and earlier
   cohorts do not contaminate peak RSS.
2. Include small and large corpora, shared and unique text, zero-token text,
   multibyte text, one content value above the byte interval target, and a
   repeated term that crosses a reduced measurement-only instance target. Let
   the production writer allocate content IDs; keep sparse and signed-ID
   boundary coverage in low-level deterministic FTS tests rather than mutating a
   measured production-seeded database. Never resolve an ordinary provider root
   or copy contributor data.
3. Make a document-interval feasibility probe the first doctor deliverable.
   Against equal generated databases, run actual
   `fts5vocab(...,'instance')` queries over one, two, and many document-ID
   intervals, capture normalized `EXPLAIN QUERY PLAN` output, and alternate
   elapsed/RSS measurements. Node's current SQLite API has no stable statement
   status or progress-handler seam, so do not promise VM-step or internal
   virtual-table traversal counters.
4. Stop before the production refactor and current-behavior documentation
   changes if the interval query repeatedly scans the complete actual vocabulary
   or elapsed work scales with corpus size multiplied by interval count. RSS and
   elapsed scaling are evidence, not deterministic proof. Still publish the
   feasibility report and decision record, then preserve the current exact audit
   while a different bounded design is prepared.
5. This delivery ends after producing the feasibility report. It does not add a
   production work observer or change production FTS validation. A human
   reviewer must explicitly accept the recorded result before sections 2–3 are
   authorized. Record that accepted or rejected decision in the architecture
   memo or a successor plan; an executor cannot infer acceptance from elapsed
   time alone.
6. The script reports only generated corpus sizes, database bytes, interval
   counts and bounds, normalized aggregate plan facts, phase durations,
   child-process peak RSS, exact query equality, final health, and
   main-file/sidecar equality. It uses mode-`0700` temporary roots, mode-`0600`
   owned files, cleans on success and failure, and stays outside `pnpm check`.
7. Add a script-contract test that rejects private fields, proves child and
   temporary-file cleanup after a forced failure, and requires healthy exact
   results. Elapsed time and RSS are report-only; semantic equality, immutable
   persistent state, interval accounting, and complete cleanup are hard
   assertions.

### Slice 1 result

The generated production-writer measurement is recorded in
[`docs/research/doctor-document-interval-feasibility.md`](../../docs/research/doctor-document-interval-feasibility.md).
Document-bounded actual-vocabulary queries retained the same virtual-table plan
shape as unbounded queries. On the large cohort, the proposed 512-row/16-MiB
admission rule produced 41 intervals, made total work 3.80 times slower, and
made grouped term-summary work 6.82 times slower. The actual-vocabulary probe's
peak RSS ratio was 0.96; it deliberately does not measure the expected-side
projection whose memory the full design intended to bound.

Human review accepted the recommendation on 2026-07-23. Sections 2–3 are retired
and must not be implemented. Production doctor behavior remains unchanged;
successor investigation is owned by
[the single-pass FTS feasibility plan](260723-doctor-single-pass-fts-feasibility.md).

### 2–3. Retired: document-ID interval verification

The accepted slice-1 decision rejects this design because document-bounded
actual-vocabulary scans multiply dominant work by interval count. The dependent
term-range proposal is not authorized independently in this program. Preserve
the current exact audit. Any reusable technique must be re-established through
the successor plan rather than copied from these retired sections.

### 4. Page only orphan repair candidates

1. Replace
   `src/infrastructure/sqlite/sqlite-index-repair-orphans.ts:readContentWindow`
   with `readOrphanCandidateWindow`. Use one keyset anti-join over
   `sessions_content_values`, ordered by signed `content_id`, with
   `NOT EXISTS` against `sessions_content_occurrences` and a fixed candidate
   limit. Return `length(CAST(content.text AS BLOB))` as exact candidate bytes.
   The first page has no cursor predicate; later pages use
   `content_id > :cursor`.
2. The existing `scanLimit` becomes a private orphan-candidate page bound
   named `candidateLimit`. Rename the composition option in
   `src/infrastructure/sqlite/index-maintenance.ts:SqliteIndexMaintenanceOptions`
   from `repairScanLimit` to `repairCandidateLimit` and update its
   `repairOrphans` wiring and focused tests. Do not add a public limit, cursor,
   or partial result. Use the existing
   `sessions_content_occurrences_content_idx`; record `EXPLAIN QUERY PLAN` or a
   stable statement-observer assertion without tying tests to elapsed time.
3. Apply the byte admission to orphan candidates only. If the next candidate
   would exceed the byte target after at least one selection, advance only
   through the last selected ID so the skipped candidate is seen on the next
   page. Process one oversized candidate alone.
4. Keep `assertCandidateReady` inside the same leased immediate transaction
   immediately before deletion. Preserve
   `deleteUnreferencedContentCandidates`, exact returned/deleted-row equality,
   `assertCandidateDeleted`, FTS-trigger deletion, renewable lease fencing, and
   aggregate decimal row/byte totals.
5. Return exhausted immediately when the candidate query finds no row. Preserve
   the initial checkpoint/fence and one checkpoint/fence after every non-empty
   committed batch, but remove zero-deletion batch progress and checkpoints. A
   healthy no-orphan library performs one candidate query and returns
   `unchanged`.
6. Orphan repair remains uncertified. It must not initialize or advance
   `sessions_index_generation_receipt`, mark the repair generation clean, or
   publish a clean proof. The next index still selects full validation unless
   independently eligible through an already accepted proof path.
7. Add a private synchronous test seam between candidate selection and the
   readiness assertion so a focused test can make a selected candidate
   referenced before deletion. The production composition supplies no hook.
   The assertion remains authoritative; this seam must not enter the public
   maintenance port or permit asynchronous work inside the immediate
   transaction.
8. Extend
   `test/infrastructure/index-maintenance-repair-orphans.test.ts` with a large
   referenced-only library, sparse orphans separated by referenced regions,
   row and byte bounds, one oversized candidate, signed-ID order, retained
   shared evidence, a candidate that becomes referenced, missing FTS state,
   later-batch failure/restart, raw worker exit, live refusal, expired takeover,
   stale-owner fencing, and exact totals. Require the receipt row and sequence
   to remain unchanged and no new clean seal/proof to be published. Any repair
   that acquired a writer generation—unchanged, repaired, post-acquisition
   failed, or crashed—makes the prior proof ineligible and sends the next index
   through full validation. A refusal or failure before acquisition preserves
   the prior generation and proof eligibility.
9. Update `docs/reference/cli-contract.md`,
   `docs/contributing/storage.md`, `docs/contributing/architecture.md`,
   `docs/contributing/testing.md`, and `docs/architecture-memo.md` to say repair
   pages orphan candidates. Public no-limit/no-cursor behavior, exact totals,
   restart semantics, and the post-repair doctor contract remain unchanged.

## Deferred candidate: certified cleanliness through compact

Compact remains deliberately uncertified and is not executable scope here. A
future investigation requires a separately accepted measurement plan and, only
if its evidence justifies changing the proof lifecycle, a separate ADR and
executor plan. This program must not modify compact, clean-proof, or certified
receipt behavior.

## Live smoke protocol

Run deterministic tests and generated measures first. A live doctor smoke is
read-only but still requires explicit authorization because it reads the
ordinary retained library.

1. Require `sessions paths` state `ready`. Stop on recovery, migration, unsafe,
   incompatible, or live-writer state; do not recover or index as part of the
   smoke.
2. Run one doctor process at a time. Do not open a second SQLite connection
   while its immutable snapshot is active.
3. Record the main database device/inode/mode/link count/size/mtime/ctime and
   WAL/SHM absence privately before and after.
4. Redirect stdout/stderr into an owned mode-`0700` temporary directory, capture
   OS peak RSS, and run one cold then two serial warm compiled doctor processes
   with `SESSIONS_DOCTOR_TIMINGS=1`.
5. Report only health, existing allowlisted phase durations, peak RSS, database
   bytes, and persistent-file equality. The compiled public doctor has no
   private work-counter channel. Remove the temporary directory and never print
   paths, identities, terms, hashes, source metadata, or text.
6. Never smoke destructive repair or compact against the ordinary retained
   library under this plan. Use a disposable provider-free library containing
   retained rows, sparse orphans, and reusable pages. Real repair or compact
   needs separate explicit authorization after doctor identifies a need.

## Verify

- The completed feasibility delivery requires the script-contract tests and
  `pnpm measure:doctor`, with exact generated query equality, immutable
  persistent state, cleanup, and the accepted decision recorded in the
  feasibility report.
- For orphan paging, run the repair-orphans, writer-coordination, FTS repair,
  clean-proof, and lifecycle tests.
- Require exact semantic/corruption parity, bounded work counters,
  crash/restart behavior, receipt/proof gates, and immutable persistent state
  when applicable to the owning slice. Cleanup is required in every slice.
  Elapsed time and RSS are supporting evidence, not correctness gates.
- Run `pnpm check` before publishing each independently reviewable slice.

## Boundaries and stop conditions

- Do not sample evidence or replace exact bidirectional term/position equality
  with counts, hashes, or FTS `integrity-check`.
- Do not allow SQLite TEMP state to spill transcript-derived data to disk.
- Do not persist doctor work counters or add them to normal doctor JSON/stderr.
- Do not add automatic doctor, repair, compact, recovery, or index execution.
- Do not add public repair paging, progress tokens, resume cursors, or partial
  results; do not rebuild FTS from orphan repair.
- Do not certify repair, forget, clear, failed compact, or crashed compact.
- Do not claim secure erasure, partial-page repacking, or file shrink beyond
  observed whole-page reclamation.
- Do not revive sections 2–3 without new measured evidence and an explicitly
  accepted successor design.
