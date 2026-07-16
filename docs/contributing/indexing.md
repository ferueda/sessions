# Indexing

## Purpose

Indexing keeps the latest successful canonical copy of each discovered session
in the local Sessions library. It reads provider history through an adapter and
never writes to the provider.

## Flow

1. Validate and sort the selected source instances before opening the library.
2. Acquire the single index writer lease and start one run per source. Starting
   a run changes that source's coverage to `unknown`.
3. Probe the source, then exhaust and validate discovery before applying any
   candidate. Conflicting duplicates or any invalid discovery item make the
   whole discovery set incomplete.
4. Process admitted candidates in binary native-ID order. A candidate whose
   adapter version and aggregate input fingerprint match the last good revision
   is recorded as unchanged without reading its transcript again.
5. Read and validate each changed candidate. Replace its canonical document,
   public-document digest, tracking state, interned text, and FTS rows in one
   leased transaction.
6. Only after complete discovery, mark retained identities absent from that
   exact source instance as `missing`. Finish the run with `complete` coverage.

## Guarantees and failures

- An incomplete probe or discovery never proves that a retained session is
  missing. Coverage stays `unknown`, and canonical documents remain available.
- A candidate read failure is recorded and processing continues. An existing
  canonical document remains the last good copy and becomes `stale`; a
  first-read failure remains `unindexed`.
- A replacement failure rolls back the replacement, records a
  `repository-write` failure when possible, and fails the indexing operation.
- A complete scan may mark a session `missing`, but it does not delete its
  canonical document. A later matching revision becomes current without a new
  transcript read.
- Source kind, source instance, and native ID form the tracking boundary. The
  writer lease prevents concurrent maintenance or indexing writes.

## Cost and tradeoff

A run must fully discover a selected source before it can prove absence. Changed
sessions are then read and replaced one at a time; unchanged fingerprints avoid
that work. This favors deterministic results, bounded failure handling, and
last-good retention over parallel write throughput.

## Code and proofs

- Flow: `src/application/run-index.ts`,
  `src/application/discover-sessions.ts`
- Admission and revision checks: `src/application/validate-session.ts`,
  `src/application/read-session-document.ts`
- Durable writes: `src/infrastructure/sqlite/sqlite-session-index.ts`,
  `src/infrastructure/sqlite/database.ts`
- Tests: `test/application/run-index.sqlite.test.ts`,
  `test/application/discover-sessions.test.ts`,
  `test/infrastructure/sqlite-session-index.test.ts`
