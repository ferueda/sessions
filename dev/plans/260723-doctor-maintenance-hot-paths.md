# Bound doctor and maintenance work without weakening integrity

## Goal

Make `doctor` and routine maintenance use bounded transient work while keeping
Sessions' exact, fail-closed evidence contracts.

The first priority is doctor FTS verification. Today
`ftsProjectionSemanticContentIsValidReadOnly` builds a second complete FTS5
projection from every retained canonical content value in memory, then compares
the complete expected and actual vocabularies. Its term ranges normally target
1,000,000 instances, but one term above that target is still compared as one
unbounded range. On a large retained library this duplicates a corpus-sized
search structure before useful progress is visible and is the most likely cause
of reports that doctor appears to hang.

The second priority is orphan repair. It currently pages all content rows,
tests reachability row by row, and executes a fenced zero-deletion batch for
windows containing only referenced content. The desired query should page only
orphan candidates while preserving the transaction-time reachability recheck.

Carrying certified cleanliness through a successful compact is outside this
plan. Compaction deliberately invalidates the previous clean proof today. Any
investigation into carrying, but never manufacturing, cleanliness requires a
separately accepted measurement plan and ADR.

Doctor remains an immutable, exact whole-library audit. Repair remains
uncertified maintenance. The program changes no provider behavior, query
result, public command grammar, structured output, exit code, or retention
policy. The feasibility measure, bounded doctor refactor, and orphan paging land
as separate PRs. The feasibility result requires explicit acceptance before the
bounded doctor refactor is authorized.

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

### 2. Verify expected FTS content in bounded exact intervals

1. Do not start this section until the slice-1 feasibility result is explicitly
   accepted. If it is rejected, preserve the current exact audit and replace
   this design through a new or materially revised plan.
2. Add a private best-effort work observer in
   `src/infrastructure/sqlite/fts-projection.ts`, composed from
   `src/infrastructure/sqlite/sqlite-index-health.ts:inspectDatabaseHealth`.
   Keep it out of the application health port and public doctor result.
   Allowlisted aggregate fields are:
   - canonical rows and UTF-8 bytes inspected;
   - expected interval count and maximum interval rows/bytes;
   - oversized-content interval count;
   - term summaries and ordinary term ranges compared;
   - oversized terms and coordinate ranges compared;
   - actual/expected instances compared and maximum range size.
3. Isolate and swallow observer callback failures. They must not affect semantic
   health, cleanup, stdout, stderr, or the exit code, and the observer must never
   receive text, terms, content IDs, hashes, identities, paths, timestamps, SQL
   text/errors, or lease values.
4. Refactor
   `src/infrastructure/sqlite/fts-projection.ts:ftsProjectionSemanticContentIsValidReadOnly`
   so it never retains one corpus-sized expected projection or a corpus-sized
   interval list. Keep `PRAGMA temp_store = MEMORY` and fail closed unless
   SQLite confirms memory-only TEMP storage.
5. Replace `loadExpectedDoctorProjectionInsideSavepoint` with interval-local
   helpers such as `scanDoctorContentIntervals`,
   `loadDoctorExpectedInterval`, and `dropDoctorExpectedProjection`.
   Construct intervals by keyset-reading `content_id` and exact
   `length(CAST(text AS BLOB))`, then load the corresponding canonical
   `content_id,text` rows in signed-ID order.
6. Use fixed private admission targets of at most 512 canonical rows and exactly
   `16 * 1024 * 1024` UTF-8 bytes per expected interval. A single canonical
   value above the byte target is processed alone, counted as oversized, and
   never truncated, skipped, split into invented canonical rows, or spilled to
   disk.
7. For each interval:
   - create a fresh contentless TEMP FTS5 table plus only the vocab tables
     needed for that comparison;
   - preserve the original signed row IDs;
   - load inside a private savepoint that composes with an existing outer
     transaction;
   - compare docsize in both directions;
   - compare exact term/document/column/offset instances in both directions;
   - close iterators, roll back or release the savepoint, and drop every TEMP
     object before advancing.
8. Cover actual document IDs exactly with half-open signed-ID intervals. The
   first interval includes the actual prefix through its last canonical ID;
   later intervals cover `(previousLastId,lastCanonicalId]`; after the final
   interval, the actual docsize and vocabulary tail must be empty. This detects
   extra actual documents before the first canonical row, between sparse
   canonical IDs, and after the last row. An empty canonical table requires an
   empty actual projection.
9. Derive each interval's actual and expected term summaries from the
   `instance` vocabulary restricted by that interval's document bounds, grouped
   by term with exact distinct-document and instance counts. The `doc` column of
   the current `fts5vocab(...,'row')` table is a document count, not a document
   ID; never filter or reuse whole-library row-vocabulary summaries as if it
   were an interval coordinate.
10. The feasibility gate in slice 1 must already have shown that this exact
    document-bounded access shape does not multiply whole-vocabulary work.
    Bounded memory alone is not sufficient justification for accidental
    superlinear CPU.
11. Preserve primary-error precedence. Load, comparison, iterator, or cleanup
    failure makes semantic health false; cleanup noise must not replace the
    original failure. Repeated calls and calls inside the current immutable
    snapshot must leave no TEMP or persistent artifact.

### 3. Stream term ranges and partition an oversized term

1. Replace
   `src/infrastructure/sqlite/fts-projection.ts:matchingDoctorTermRanges` and
   the retained `DoctorTermRange[]` with immediate, streaming comparisons.
   Walk actual and expected term summaries in UTF-8 binary order. Require exact
   term, document-count, and instance-count equality before comparing
   positions.
2. Accumulate complete ordinary terms only until either side reaches the
   existing 1,000,000-instance target, compare that range in both directions,
   then discard its bounds. Never sample terms, documents, or positions and
   never replace exact instance equality with aggregate counts or hashes.
3. When one term exceeds the target, partition its exact ordered coordinate
   space `(doc,col,offset)`. Build each half-open upper boundary with bounded
   lookahead from both actual and expected vocabularies and choose the earlier
   target-th coordinate, so neither side can place more than the target in one
   comparison. Compare actual-only and expected-only rows before advancing.
4. Cover the first coordinate, signed 64-bit document IDs, boundaries that fall
   on different sides, and the final tail. Equal total counts are not proof:
   shifted documents, columns, or offsets must still fail.
5. Extend `test/infrastructure/sqlite-fts-projection.test.ts` with:
   - healthy equality across row/byte intervals, sparse IDs, zero-token rows,
     multibyte terms, and one oversized canonical value;
   - missing, extra, and malformed docsize in the first, middle, and final
     interval;
   - extra actual documents before, between, and after canonical IDs;
   - wrong terms with equal token counts, changed positions, cross-document
     swaps, and unequal counts under the same term universe;
   - a healthy oversized term spanning several coordinate ranges;
   - actual-only, expected-only, shifted-document, and shifted-offset damage on
     both sides of boundaries;
   - an adversarial distribution that would exceed the target if boundaries
     came from only one side;
   - invalid private limits, load/comparison/observer/drop failures, outer
     transaction composition, and repeated invocation.
6. Extend `test/infrastructure/sqlite-index-health.test.ts` to require the same
   public `ReadyIndexHealth` decisions for healthy, docsize-damaged, and
   semantic-damaged libraries. Extend `test/doctor-no-persistence.test.ts` with
   a worker stopped after its first interval; the parent must see unchanged
   main-file identity/stat, no WAL/SHM, and no persistent TEMP artifact.
7. Reconcile the current-behavior descriptions in
   `docs/reference/cli-contract.md`, `docs/privacy.md`,
   `docs/contributing/storage.md`, `docs/contributing/architecture.md`,
   `docs/contributing/testing.md`, and `docs/architecture-memo.md`. Describe
   exact interval coverage, the one-oversized-content exception, coordinate
   partitioning, and the memory-only TEMP rule. Do not make the private work
   observer part of the public CLI contract.

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

- For the feasibility delivery, run the script-contract tests and
  `pnpm measure:doctor`; require exact generated query equality, immutable
  persistent state, and cleanup, then stop for explicit acceptance.
- For bounded doctor after that acceptance, run the focused FTS projection,
  index health, no-persistence, immutable snapshot, and measurement-contract
  tests, then `pnpm measure:doctor`.
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
- Stop and redesign bounded doctor if interval cleanup cannot remain
  memory-only, exact coverage weakens, or actual-vocabulary work becomes
  superlinear in interval count.
