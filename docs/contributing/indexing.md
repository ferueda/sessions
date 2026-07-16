# Indexing

## Purpose

Indexing keeps the latest successful canonical copy of each discovered session
in the local Sessions library. It reads provider history through an adapter and
never writes to the provider.

## Flow

1. Validate and sort the selected source instances before opening the library.
2. Acquire the single index writer lease, which makes the new generation dirty,
   and start one run per source. Starting a run changes that source's coverage
   to `unknown`.
3. Probe the source, then exhaust and validate discovery before applying any
   candidate. Conflicting duplicates or any invalid discovery item make the
   whole discovery set incomplete.
4. Process admitted candidates in binary native-ID order. A candidate whose
   adapter version and aggregate input fingerprint match the last good revision
   is recorded as unchanged without reading its transcript again.
5. Read and validate each changed candidate. Replace its canonical document,
   public-document digest, tracking state, interned text, and FTS rows in one
   leased transaction. Record ordinary typed failures immediately, but hold a
   first-attempt `source-changed` outcome until the primary pass finishes.
6. If any source-change outcomes were held, perform one fresh complete
   rediscovery for that source and retry only those original identities, in
   their primary order. A fresh last-good revision becomes unchanged without a
   transcript read. Ignore identities found only by rediscovery.
7. Using only the primary discovery's `seen` set, mark every tracked identity
   absent from that exact source instance as `missing`. This includes a failed
   first capture that has tracking evidence but no canonical document. Finish
   the run with `complete` coverage.
8. After all index work and cleanup succeeds, seal and release only the exact
   owned generation, close the database, harden its files, and publish the
   private post-close proof last.

## Guarantees and failures

- An incomplete probe or primary discovery never proves that a retained session
  is missing. Coverage stays `unknown`, and canonical documents remain
  available.
- A first-attempt `source-changed` failure receives at most one fresh retry per
  source run. Incomplete rediscovery, a vanished original identity, or another
  typed read failure records one terminal failure. Other candidate read failures
  are recorded without retry. An existing canonical document remains the last
  good copy and becomes `stale`; a first-read failure remains `unindexed`.
- The primary discovery alone controls coverage, the `seen` set, and missing
  reconciliation. A retry-only identity cannot change those decisions, and a
  failed retry does not make an otherwise complete primary scan incomplete.
- A replacement failure rolls back the replacement, records a
  `repository-write` failure when possible, and fails the indexing operation.
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
- Recovery, migration, maintenance, abandoned work, or failed cleanup keeps the
  generation dirty and uses the existing full canonical, foreign-key, and FTS
  validation/repair path.
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
that work. Source-change recovery may add one complete rediscovery for the
source, shared by every affected primary candidate. It never adds a per-candidate
discovery, sleep, backoff, or retry loop. This favors deterministic results,
bounded failure handling, and last-good retention over parallel write throughput.

## Opt-in timing

`SESSIONS_INDEX_TIMINGS=1 sessions index ...` measures the shipped indexing path.
It writes one `sessions:index-timings` JSON record to stderr after the command.
The fixed phases cover source resolution, writer open, probe/discovery,
freshness reads, unchanged writes, changed reads, replacement, reconciliation,
run bookkeeping, close, and total elapsed time. Each phase contains only a call
count and elapsed milliseconds.

The source port returns an already normalized document, so
`changedReadAndNormalize` honestly combines provider reading, adapter
normalization, and application admission. Add deeper adapter-local measurement
only if this combined phase becomes the measured bottleneck.

Timing is disabled by default, is never stored, and does not change stdout,
reports, exit codes, or indexing decisions. The diagnostic has no identities,
paths, fingerprints, timestamps, errors, or transcript-derived values. Timing
clock, collection, and stderr failures are best-effort and cannot replace the
underlying command result.

The accepted baseline selected writer open as the measured owner. After the
clean-generation fast path, a fixed synthetic 2,000-session exact-equality run
used 2.525 ms for writer open and 261.254 ms total. An authorized read-only real
Codex 120-session exact-cohort run used 14.008 ms and 381.767 ms, with zero
changed reads. Both local budgets passed. These measurements are implementation
evidence, not public performance guarantees.

## Code and proofs

- Flow: `src/application/run-index.ts`,
  `src/application/discover-sessions.ts`, `src/application/index-timing.ts`
- Admission and revision checks: `src/application/validate-session.ts`,
  `src/application/read-session-document.ts`
- Durable writes: `src/infrastructure/sqlite/sqlite-session-index.ts`,
  `src/infrastructure/sqlite/database.ts`
- Clean state: `src/infrastructure/sqlite/writer-lease.ts`,
  `src/infrastructure/sqlite/writer-clean-proof.ts`
- FTS structure, repair, and semantic doctor proof:
  `src/infrastructure/sqlite/fts-projection.ts`
- Timing aggregation: `src/infrastructure/runtime/index-timings.ts`
- Tests: `test/application/run-index.sqlite.test.ts`,
  `test/application/discover-sessions.test.ts`,
  `test/infrastructure/sqlite-session-index.test.ts`
