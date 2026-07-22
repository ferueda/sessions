# Indexing

## Purpose

Indexing keeps the latest successful canonical copy of each discovered session
in the local Sessions library. It reads provider history through an adapter and
never writes to the provider.

## Flow

1. Validate and sort the selected source instances. For implicit all-provider
   indexing, probe availability before writer open and report valid unavailable
   providers as skipped. If every provider is unavailable, return without
   opening or creating the library.
2. If any source remains, acquire the single index writer lease, which makes the
   new generation dirty. Select `fast`, `certified-recovery`, `bootstrap`, or
   `full-validation` from the locked prior generation and bounded structure
   evidence. After validation, FTS configuration, and capture-workspace setup
   succeed, create the new generation's sequence-zero recovery receipt. Then
   start one run per source. Starting a run changes that source's coverage to
   `unknown`.
3. Probe the source, then exhaust and validate discovery before applying any
   candidate. Conflicting duplicates or any invalid discovery item make the
   whole discovery set incomplete.
4. Process admitted candidates in binary native-ID order in fixed slices of 128.
   Read freshness for one whole slice. A candidate whose adapter version and
   aggregate input fingerprint match the last good revision is buffered with
   consecutive unchanged candidates and recorded in one bounded write, without
   reading its transcript again.
5. Read and validate each changed candidate. Replace its canonical document,
   public-document digest, exact document metrics, tracking state, interned text,
   and FTS rows in one leased transaction. Record ordinary typed failures
   immediately, but hold a first-attempt `source-changed` outcome until the
   primary pass finishes. Every durable index operation performs its local
   postconditions and advances the generation receipt once before that same
   transaction commits.
6. If any source-change outcomes were held, perform one fresh complete
   rediscovery for that source and retry only those original identities, in
   their primary order. Retry freshness and unchanged writes use the same
   bounded slices. A fresh last-good revision becomes unchanged without a
   transcript read. Ignore identities found only by rediscovery.
7. Page tracked identities for the exact source instance in binary native-ID
   order, 128 at a time. Merge each page against the immutable primary discovery
   and record absent identities as `missing` in a bounded write. This includes a
   failed first capture that has tracking evidence but no canonical document.
   Reconciliation builds no second corpus-sized `seen` set or tracked-identity
   list. Finish the run with `complete` coverage.
8. After all index work and cleanup succeeds, seal and release only the exact
   owned generation, close the database, harden its files, and publish the
   private post-close proof last.

Cooperative cancellation is checked before writer acquisition and before and
after each application page, batch, or single-candidate operation. It is not
passed into provider adapters or SQLite transactions. Cancellation during
discovery returns no candidate set; cancellation after a changed read discards
that result before replacement; and cancellation after a committed replacement
or completed batch preserves that complete transaction. Checks around every
reconciliation page/write and source completion prevent a partial scan from
proving complete coverage. Writer close records any still-active run as
`interrupted` with unknown coverage.

## Guarantees and failures

- An incomplete probe or primary discovery never proves that a retained session
  is missing. Coverage stays `unknown`, and canonical documents remain
  available.
- Only valid `unavailable` probes are skipped. Explicitly selected, unreadable,
  invalid, throwing, or post-preflight unavailable sources fail.
- A first-attempt `source-changed` failure receives at most one fresh retry per
  source run. Incomplete rediscovery, a vanished original identity, or another
  typed read failure records one terminal failure. Other candidate read failures
  are recorded without retry. An existing canonical document remains the last
  good copy and becomes `stale`; a first-read failure remains `unindexed`.
- The primary discovery alone controls coverage and missing reconciliation. A
  retry-only identity cannot change those decisions, and a failed retry does not
  make an otherwise complete primary scan incomplete.
- A replacement failure rolls back the replacement, records a
  `repository-write` failure when possible, and fails the indexing operation.
- Each freshness result must match the requested identity and each tracked page
  must be bounded, source-correct, strictly advancing, and honest about whether
  more rows remain. Invalid repository results fail the run; they cannot be used
  to skip a candidate or prove absence.
- An unchanged or missing batch is one transaction. A failing batch rolls back
  as a unit. Earlier completed batches may remain as a durable prefix, but the
  active run finishes incomplete with unknown coverage and the next index is
  safe to repeat.
- A complete scan may mark a session `missing`, but it does not delete its
  canonical document or tracking-only failure evidence. A failed first capture
  can therefore be both `unindexed` and `missing`; later successful capture
  creates its first retained document. A retained matching revision becomes
  current without a new transcript read.
- Source kind, source instance, and native ID form the tracking boundary. The
  writer lease prevents concurrent maintenance or indexing writes.
- A matching clean lease generation and stat-bound post-close proof allow the
  next ready, sidecar-free, current-schema open to use constant-size schema/FTS
  structure checks. Missing, stale, malformed, or unsafe proof disables only
  this optimization.
- An exact receipt beside an expired index lease may use the same bounded catalog
  and FTS structure checks. Acquisition interrupts the abandoned run, clears the
  old receipt, and starts a new run from discovery; it never resumes the old run.
  Each supported committed index mutation and its receipt sequence advance are
  atomic.
- Missing, stale, malformed, wrong-generation, free, maintenance, migration-era,
  or structurally unsafe receipt evidence uses the full canonical
  document/digest/metrics, foreign-key, and FTS validation/repair path. A live
  owner remains busy, an expired clear owner remains clear-only, and incompatible
  lifecycle states fail closed.
- The first foreground `SIGINT` or `SIGTERM` requests cooperative cancellation
  and maps a successfully cleaned stop to exit `130` or `143`. Operation and
  cleanup errors keep their existing precedence. A crash, `SIGKILL`, or failed
  cleanup remains dirty. The next writer may use certified recovery only when
  the crash left an exact expired index lease and a matching receipt at a
  completed mutation boundary; otherwise it performs full validation.
- Changed documents are reconstructed and digest-checked after replacement;
  affected canonical content IDs must match their FTS rows. Direct out-of-band
  SQLite edits are unsupported.

List, search, and entries report a page-level capture scope built from this
tracking state. Doctor reports the same global aggregate. Capture scope describes
which evidence may be unavailable; it does not claim that an unindexed session
matched or failed a canonical metadata or transcript filter.

## Cost and tradeoff

A run must fully discover a selected source before it can prove absence. Changed
sessions are then read and replaced one at a time; unchanged fingerprints avoid
that work. Freshness reads, unchanged writes, tracked-identity reads, and missing
writes are bounded to 128 identities per repository call. Source-change recovery
may add one complete rediscovery for the source, shared by every affected primary
candidate. It never adds a per-candidate discovery, sleep, backoff, or retry
loop. The complete primary discovery remains corpus-sized because it is the
source snapshot that proves coverage, but incremental repository work and
reconciliation memory do not add another corpus-sized identity collection. This
favors deterministic results, bounded failure handling, and last-good retention
over parallel write throughput.

## Opt-in timing

`SESSIONS_INDEX_TIMINGS=1 sessions index ...` measures the shipped indexing path.
It writes one `sessions:index-timings` JSON record to stderr after the command.
The fixed phases cover source resolution, writer open, canonical validation,
foreign keys, FTS structure/content/semantic validation, FTS rebuild,
availability and run probes, discovery, freshness reads, unchanged writes,
changed reads, replacement, reconciliation, run bookkeeping, close, and total
elapsed time. Each phase contains only a call count and elapsed milliseconds.

The source port returns an already normalized document, so
`changedReadAndNormalize` honestly combines provider reading, adapter
normalization, and application admission. Add deeper adapter-local measurement
only if this combined phase becomes the measured bottleneck.

Timing is disabled by default, is never stored, and does not change stdout,
reports, exit codes, or indexing decisions. The diagnostic has no identities,
paths, fingerprints, timestamps, errors, or transcript-derived values. Timing
clock, collection, and stderr failures are best-effort and cannot replace the
underlying command result.

The fixed synthetic 2,000-session measurement compares a clean open, an
abandoned exact certified generation, and a receipt-invalidated
full-validation control from equal cloned libraries. Stable runs must use
exactly 16 freshness reads, 16 unchanged writes, and 16 tracked-identity page
reads at the current 128-item bound, with equal reports, canonical and tracking
state, health, representative queries, a final clean proof, and zero source
reads. Certified recovery must record no global validation phase; the
invalidated control must exercise the complete fallback. A separate equal clone
completes an empty discovery through 16 tracked pages plus 16 missing writes,
retains all canonical/query evidence, exposes every session as
current-but-missing, and retains the first 100 ordered run items while reporting
1,900 omitted items. Measurements assert deterministic ownership and
correctness, not elapsed-time thresholds or public performance guarantees.

## Code and proofs

- Flow: `src/application/run-index.ts`,
  `src/application/discover-sessions.ts`, `src/application/index-timing.ts`
- Admission and revision checks: `src/application/validate-session.ts`,
  `src/application/read-session-document.ts`
- Durable writes: `src/infrastructure/sqlite/sqlite-session-index.ts`,
  `src/infrastructure/sqlite/database.ts`
- Clean state: `src/infrastructure/sqlite/writer-lease.ts`,
  `src/infrastructure/sqlite/writer-clean-proof.ts`
- Crash-boundary certification:
  `src/infrastructure/sqlite/writer-recovery-receipt.ts`
- FTS structure, repair, and semantic doctor proof:
  `src/infrastructure/sqlite/fts-projection.ts`
- Timing aggregation: `src/infrastructure/runtime/index-timings.ts`
- Signal ownership: `src/infrastructure/runtime/index-interrupt.ts`
- Tests: `test/application/run-index.sqlite.test.ts`,
  `test/application/discover-sessions.test.ts`,
  `test/infrastructure/sqlite-session-index.test.ts`
