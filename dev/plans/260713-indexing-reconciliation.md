# Implement provider-neutral indexing and writer safety

## Goal

Implement M4 of the V1 roadmap on top of the M3 canonical repository. One
provider-neutral application service must own explicit source selection,
complete discovery, incremental reads, last-good failure behavior,
source-scoped reconciliation, durable run reports, and deterministic cleanup
without adding a concrete provider branch.

Acceptance requires a fake source to exercise the complete lifecycle against
real SQLite: unchanged candidates are not read, adapter-version changes are
re-read, failed refreshes retain last-good documents, incomplete discovery
removes nothing, complete discovery removes only unseen canonical documents
for the exact source instance, and reports use the repository's durable counts.
Only one high-level writer may own the index. A later writer must safely recover
an abandoned run while fencing the previous process. Explicit clear removes
only known Sessions files, and doctor reports index health without mutating
state. M4 remains internal: generated CLI help still exposes only `doctor` and
`paths`.

## Changes

1. `src/application/ports/session-source.ts`,
   `src/application/validate-session.ts`, and
   `src/application/read-session-document.ts` — add an admitted discovered
   candidate that deeply snapshots the complete `DiscoveredSession` together
   with its branded `SessionObservation`; adapter getters or later mutation must
   not change comparison or read inputs. Make the read boundary pass that
   admitted snapshot to `SessionSource.read()` while retaining the existing
   bounded, path-only validation and typed safe failures.

   Define an exact selected-source value that binds one validated
   `SourceInstance` to one `SessionSource`. Reject duplicate selections before
   opening the index; require `adapter.kind`, `probe().source`, every candidate
   identity, and any trusted source failure to match the selected `(kind,
instanceId)`. Reports always use the selected source rather than trusting a
   mismatched adapter-supplied value.

   Fully exhaust and admit discovery before any session mutation. Collapse only
   structurally identical duplicates. A malformed candidate, wrong source,
   conflicting duplicate, or thrown iterator makes that source scan incomplete,
   performs no candidate reads or session writes, and disables reconciliation.
   Sort selected sources and admitted candidates with deterministic binary string
   comparison, not locale-sensitive ordering.

2. `src/application/ports/session-index.ts` and the SQLite repository — add a
   deterministic `listIndexedIdentities(source)` reconciliation capability. It
   returns only identities that currently have canonical content, including
   stale documents, ordered by exact native ID; failed-first and already removed
   tracking records are excluded. Keep removal policy in the application layer
   and preserve exact source-instance isolation.

   Make the repository the sole authority for run reports. Remove caller-supplied
   counts from `finishRun`; finalization reads the stored counters and ordered
   bounded run items, applies the requested completed/incomplete status, and
   returns an immutable result containing counts, up to 100 provider-neutral
   failed/removed item diagnostics, and omitted-item count. Items expose only
   canonical identity, outcome, and typed failure code—never content, locator, or
   raw errors. Preserve the M3 rule that a failed `replaceSession` records
   `repository-write` at most once before rejecting. The caller must never follow
   that rejection with `recordFailure`. Tests continue to prove the schema
   invariant `discovered = unchanged + updated + failed`, with removed separate
   and stale bounded by failed, plus deterministic item order and truncation
   after the durable 100-item cap.

3. Add `src/application/run-index.ts` plus focused report/error values. The
   service accepts owned `IndexPaths`, exact selected sources, `IndexLifecycle`,
   and an injected clock; it opens one coordinated writer for the invocation and
   processes sources sequentially in deterministic order.

   For each source, start a durable run even when its probe is unavailable,
   unreadable, invalid, or throws. A returned or typed thrown `unavailable`/
   `unreadable` maps to durable `source-unavailable`/`source-unreadable`.
   Unexpected throws, malformed probe values, wrong source identity, and probe
   failure kinds invalid at this boundary map to a new sanitized `probe-failed`
   run failure code. They perform no discovery/candidate/session mutation,
   finalize an incomplete source report from durable zero counts/items, and let
   the next selected source proceed. A ready source follows this policy:

   - complete the discovery preflight from change 1;
   - compare the admitted revision with repository freshness;
   - call `recordUnchanged` without `read()` when a current or stale document's
     last-good fingerprint and adapter version match;
   - otherwise call the validated read boundary and atomically replace the
     document, or record one typed source failure and continue;
   - treat every admitted candidate as seen even when its read fails;
   - only after complete discovery, remove indexed identities absent from the
     seen set for that exact source;
   - finalize from the repository-authoritative counts and ordered bounded items,
     and derive versioned provider-neutral per-source and aggregate reports from
     that durable result, including omitted diagnostics and the number of
     incomplete sources.

   Probe/discovery/source-read failures finish that source safely and allow the
   next selected source. Any repository, lease, or finalization failure aborts
   the entire invocation because persistence trust is lost. Attempt to finish
   the active run as incomplete with `repository-write` only while the writer is
   still valid; aggregate independent operation/finalization/close errors and
   preserve their causes. Use the Node error and async guidance; do not add
   parallel source/session processing, retries, raw exception text, or progress
   rendering.

4. Add `src/infrastructure/sqlite/migrations/0003-writer-coordination.ts`
   and `src/infrastructure/sqlite/writer-lease.ts`, then register schema version 3. Store one singleton operational lease with a monotonic generation, random
   opaque owner token, `index`/`clear` purpose, and canonical acquire/heartbeat/
   expiry timestamps. Free rows have only the generation; held rows require all
   owner fields. Use a fixed internal expiry and heartbeat interval with an
   injectable clock/scheduler for deterministic tests; expose neither values nor
   configuration publicly.

   Acquisition, renewal, release, and takeover use `BEGIN IMMEDIATE`. A live
   lease rejects a second writer with a sanitized operational code. Claiming a
   free or expired lease increments the generation and atomically marks every
   abandoned active run interrupted before new work begins. Every repository
   mutation—start, unchanged, failure, replace, remove, and finish—verifies the
   exact token, generation, purpose, and unexpired lease inside its own write
   transaction. Split read-only and coordinated-writer repository construction
   so production cannot create an unguarded writer. A resumed old process must
   fail with `writer-lease-lost` and change no state.

   Update `src/infrastructure/sqlite/database.ts` with a writer-specific
   preflight: retain immutable reader/doctor sidecar refusal, but allow an
   explicit path-safe writer to open valid WAL recovery state, let SQLite recover
   it, apply migrations, and then claim the lease. The internal heartbeat stops
   on loss or close. Normal close interrupts only this handle's unfinished runs,
   conditionally releases its lease, closes SQLite, and hardens files; acquisition
   failures and independent release/close/hardening failures retain the existing
   cause-preserving aggregation behavior.

5. Add a narrow provider-neutral index-maintenance port and
   `src/application/clear-index.ts`; implement it under SQLite infrastructure.
   M4 exposes no CLI route. Return an exact stable `ClearIndexReport` with
   `schemaVersion: 1`, command `index-clear`, outcome `absent` or `cleared`, and
   database/WAL/SHM removal booleans. Partial failure throws a typed sanitized
   operational error rather than returning a false success report; M5 will map
   this application value to CLI rendering and exits.

   Clearing is explicit, non-migrating, and never opens provider paths. Missing
   database/WAL/SHM state returns `absent` with all removal values false without
   creating the directory. Validate canonical paths, ownership, modes, file
   types, symlinks, and hard links before deletion; retain the cache directory
   and every unrelated file, and never recurse.

   A current schema acquires a `clear` lease, refusing a live indexing owner;
   after recovery/checkpoint it closes with that lease still fencing cooperative
   writers, revalidates owned targets, and removes SHM, WAL, then the database.
   For older, newer, incompatible, or corrupt known-path state, do not migrate:
   refuse present recovery sidecars as possibly active, otherwise revalidate and
   remove only the three known files. Missing individual targets are success;
   sanitized partial deletion failures are retryable. Same-user adversarial path
   races remain outside the documented threat boundary, but obvious substitution
   between inspection and unlink must be rejected.

6. Add a ready-index health capability to the lifecycle and enrich the existing
   `index-state` diagnostic without changing its check ID or ordering. Use the
   immutable snapshot reader for `PRAGMA integrity_check`, the first foreign-key
   violation, read-only FTS structural/content-row consistency, persistent FTS
   secure-delete configuration, sanitized lease state, and active/interrupted run
   counts. Never execute the write-shaped FTS integrity command in doctor.

   Uninitialized remains healthy. Unsafe/incompatible/recovery state, integrity
   or foreign-key failure, required persistent FTS configuration failure, and an
   active run without a valid live lease are unhealthy. Historical interrupted
   runs are reported but not themselves unhealthy. Return only stable typed
   details—never SQLite error text, SQL, owner tokens, session identities, or
   content—and prove database bytes, timestamps, migrations, run rows, directory
   entries, and absent state remain unchanged. Doctor human/JSON streams and exit
   behavior remain current; clear CLI streams belong to M5.

7. Add a programmable fake indexing source and real-SQLite integration tests.
   Keep the existing conformance fixture focused on the adapter contract; the new
   fixture needs independent controls for exact source, candidate order,
   adapter-version changes, read-call count, removal, duplicates, iterator
   failure, and per-session typed failures. Isolate every database/source fixture,
   await rejection assertions, and use fake clocks/timers rather than sleeps per
   the Vitest guidance.

   Prove probe unavailable/unreadable and invalid/thrown `probe-failed`
   finalization with zero session mutation plus continuation to the next source;
   first index and zero-read unchanged reindex; adapter-version
   invalidation; binary discovery-order independence; stale recovery when a
   candidate returns to its last-good revision; failed-first behavior;
   source-changed last-good preservation; read-failed candidates remaining seen;
   incomplete-scan zero mutation/no deletion; later complete-scan removal;
   removed same-revision re-read; two arbitrary kinds and colliding native IDs;
   and exactly one durable repository-write failure.

   Also prove durable failure/removal item reports, stable order, and omitted
   count beyond 100 items, plus exact absent/cleared `ClearIndexReport` values.
   File-backed lifecycle tests prove v2-to-v3 preservation, live-writer
   rejection, heartbeat renewal, expired takeover, abandoned-run interruption,
   stale-owner fencing, valid WAL recovery, close aggregation, clear boundaries,
   and read-only health. Update README/current architecture/privacy/testing/CLI
   docs and the V1 roadmap only after behavior exists. Keep public help tests
   proving `sessions index` is absent. Remove this executor plan and its active
   index entry after implementation and review pass.

## Verify

- `pnpm vitest run test/application/run-index.test.ts test/infrastructure/sqlite-writer-coordination.test.ts test/infrastructure/index-maintenance.test.ts test/infrastructure/index-state-diagnostic.test.ts`
- `pnpm check`
- Run the repository change-review workflow against the implementation base;
  implementation and quality must pass on the final committed head with no
  `must_fix` findings.

## Boundaries

- No Cursor, Codex, or other concrete adapter; no provider branch in domain,
  application, storage, maintenance, doctor, or reports.
- No public `sessions index` or `sessions index clear` registration until M5;
  no list/show/search/export or query/ranking work.
- No daemon, watcher, worker thread, parallel indexing, automatic retry, or
  signal/cancellation surface. Crash recovery is lease takeover plus idempotent
  reindexing, not a background service.
- No new owned lock file or `IndexPaths`/`paths` JSON field; coordination remains
  internal SQLite state.
- No automatic rebuild or repair when health checks fail, and no recursive cache
  directory deletion.
