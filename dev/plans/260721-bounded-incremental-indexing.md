# Bound routine incremental indexing work

## Goal

Make a clean, unchanged index run scale in fixed-size repository pages and
transactions instead of one freshness query and one transaction per session.
The current generic 2,000-session measurement performs 2,000 freshness reads
and 2,000 unchanged writes; those two phases account for most of the clean-run
time even though no transcript is read.

Use a fixed internal batch size of 128. This stays below SQLite's conservative
999-parameter floor for the bounded `VALUES` tables used by set-based tracking
updates. A successful run must produce the same
report, tracking state, canonical documents and digests, run diagnostics,
capture scope, queries, and final clean proof as the current path. Discovery
must still complete before any candidate write, changed sessions must still be
replaced one at a time, and missing reconciliation must still wait until the
primary pass and its one bounded retry finish. No provider API, CLI option, or
structured-output contract changes.

## Changes

1. `src/application/ports/session-index.ts:SessionIndexWriter` — replace the
   unbounded `listTrackedIdentities`, single-observation `recordUnchanged`, and
   single-identity `recordMissing` writer methods with three provider-neutral
   run-scoped bounded operations:

   - `getFreshnessBatch(run, identities)` accepts 1–128 identities and returns
     one freshness record per input in the same order;
   - `recordUnchangedBatch(run, observations)` accepts 1–128 observations from
     one source in strict binary native-ID order; and
   - `listTrackedIdentitiesPage(run, afterNativeId?)` returns at most 128
     identities in strict binary native-ID order plus an explicit `hasMore`
     value; and
   - `recordMissingBatch(run, identities)` accepts 1–128 identities from one
     source in strict binary native-ID order.

   Export one internal batch-limit constant from this port so the application
   and SQLite adapter cannot drift. Binding the calls to the active run lets the
   repository resolve and validate its source once per operation. Keep the
   reader's point `getFreshness` for ordinary non-index reads. Reject an
   oversized, duplicate, unordered, wrong-source, malformed, or inconsistent
   page/batch; do not silently sort repository output.

2. `src/infrastructure/sqlite/sqlite-session-index.ts` and
   `src/infrastructure/sqlite/sqlite-session-state.ts` — implement the tracking
   freshness batch as one ordered query over a bounded
   `(ordinal, native_id)` `VALUES` table joined to the active run's source
   tracking and canonical presence. Decode exactly one result per input through
   the existing validator, including aligned `untracked` results, and return in
   ordinal order. Implement tracked paging as a keyset query over the existing
   source/native-ID unique index: read at most 129 rows to derive `hasMore`,
   return only 128, and require a later page to begin strictly after its cursor.

   Implement each mutation batch in one immediate leased transaction. Validate
   the active run once, then preserve the current per-item preconditions: exact
   source ownership, existing tracking, canonical presence and exact last-good
   revision for unchanged observations, and exact affected-row counts. Use the
   bounded input table to validate the entire unchanged batch before one set
   update; use the same shape to resolve existing missing rows before their set
   update. Generalize the private run-counter update to accept one exact
   positive amount. Read run-item count/maximum once per missing batch, insert
   only the remaining slots through item 100 in input order, and increment the
   omitted count once for the rest. A missing identity that is no longer tracked
   remains a no-op. Any invalid member or affected-row mismatch rolls back that
   whole batch and marks writer integrity uncertain; earlier committed batches
   remain intact.

3. `src/application/run-index.ts:runSource`, `applyCandidate`, and
   `retrySourceChanged` — slice the already admitted, binary-sorted candidates
   into windows of at most 128 identities, fetch one aligned freshness batch,
   validate its length and exact identity order, and pass each result into the
   existing replacement decision. Reuse this processor for the bounded
   rediscovery retry; vanished original identities still record
   `source-changed` in primary order, and retry-only identities remain ignored.

   Within each window, buffer consecutive unchanged observations and flush
   before every changed/read-failure candidate and at the window end. This
   retains prefix ordering around replacements and failures while removing the
   per-session transaction. Freshness prefetch is read-only and cannot change an
   earlier candidate decision. Check cancellation before and after every batch,
   page, changed read, and transaction, never inside a synchronous SQLite
   transaction.

4. `src/application/run-index.ts` — after the primary pass and retry finish,
   merge-walk the immutable primary candidate list against
   `listTrackedIdentitiesPage`. Validate each page's source, strict order,
   cursor advancement, uniqueness, and `hasMore` contract. Emit only tracked
   identities absent from the primary list to `recordMissingBatch`, in binary
   order and at most 128 at a time. This removes the whole-source `seen` set and
   unbounded tracked-identity array
   without letting an incomplete scan, a retry-only identity, or a repository
   failure during candidate processing prove absence. Cancellation or failure
   during reconciliation may commit prior complete missing batches, as the
   current per-identity loop may commit a prefix, but the run must remain
   incomplete with coverage `unknown` unless every batch and `finishRun`
   succeeds.

5. `test/contracts/session-index.contract.ts`,
   `test/infrastructure/sqlite-session-index.test.ts`, and
   `test/infrastructure/sqlite-writer-coordination.test.ts` — cut the repository
   contract over to the bounded methods. Update the direct missing-session seed
   in `test/infrastructure/sqlite-session-query.contract.test.ts` to use a
   one-item missing batch while retaining its existing query-state assertions.
   Prove page bounds, strict cross-page binary order, all freshness states,
   exact `hasMore`, wrong cursors/sources, lease loss, 128/129/257 boundaries,
   aligned current/stale/unindexed/untracked freshness, batch count updates,
   bounded run-item order, missing no-op behavior, and whole-batch rollback when
   one unchanged or missing member is invalid. Keep canonical replacement and
   point-reader coverage unchanged.

6. `test/application/run-index.test.ts`,
   `test/application/run-index.sqlite.test.ts`, and
   `test/application/run-index-timing.test.ts` — update the fake port and add
   workflow cases above one batch. Prove complete discovery precedes the first
   page/mutation, stable candidates never call `read`, changed/failure ordering
   flushes prior unchanged work, retry-only identities do not enter
   reconciliation, a second-batch error leaves the first batch committed but
   coverage unknown, and cancellation occurs only between batches. Through
   real SQLite, assert exact report, tracking/canonical state, run-item order,
   capture scope, representative queries, health, and clean proof for mixed
   unchanged/changed/failed/missing input spanning several pages.

7. `scripts/measure-indexing.ts` — keep the existing equal-clone semantic
   checks and zero stable source reads, then require the 2,000-session unchanged
   run to use `ceil(2000 / 128)` freshness batches, unchanged transactions, and
   reconciliation pages instead of 2,000 calls each. Add an equal seeded clone
   with an empty complete primary discovery and require 2,000 missing results,
   100 ordered run items, 1,900 omitted items, unchanged canonical bodies and
   digests, expected missing-state queries, zero provider reads, and the same
   bounded page/write count. Report elapsed phases without adding a wall-clock
   release threshold. The recovery clone must remain semantically equal and
   exercise the same bounded routine mutations after writer open.

8. `docs/contributing/indexing.md`, `docs/contributing/testing.md`, and the
   cross-cutting maintenance section of `docs/architecture-memo.md` — describe
   the now-current candidate batches and reconciliation merge, fixed internal
   batch boundary, cancellation and partial-prefix failure semantics, and
   measured aggregate call counts. Record only generic aggregate evidence; do
   not turn local timings into a public performance promise.

## Verify

- `pnpm test test/application/run-index.test.ts test/application/run-index.sqlite.test.ts test/application/run-index-timing.test.ts test/infrastructure/sqlite-session-index.test.ts test/infrastructure/sqlite-session-query.contract.test.ts test/infrastructure/sqlite-writer-coordination.test.ts`
- `pnpm measure:indexing`
- `pnpm check`

## Boundaries

- Do not parallelize sources, candidates, changed reads, or SQLite writes.
- Do not write before complete discovery, reconcile before the primary retry
  finishes, read an unchanged transcript, or delete missing canonical data.
- Do not expose a batch-size flag or change reports, structured output,
  canonical digests, failure codes, replacement transactions, or the one-retry
  contract.
- STOP if paging cannot remain stable under the single writer lease, if a
  successful batched run differs from the existing durable/public result, or if
  an incomplete primary discovery can reach either mutation merge.
