# Reduce indexing work without weakening evidence guarantees

## Goal

Reduce corpus-sized provider discovery work and statement-per-content
replacement work while preserving the indexing contract: discovery remains
complete before absence is inferred; provider histories remain read-only;
source mutation proofs remain exact; candidate and failure order stays
deterministic; failed refreshes preserve last-good canonical state; and leases,
recovery receipts, canonical readback, document digest/metrics checks, and
affected canonical/FTS parity remain authoritative.

Routine unchanged indexing is not the main target. The existing deterministic
2,000-session baseline already uses 16 freshness reads, 16 unchanged writes,
and zero stable transcript reads; a local generated run completed in roughly
53–59 milliseconds. Current structural opportunities are:

- Cursor maps every materialized agent with `catalog.stores.find`, producing
  O(agent × store) lookup work.
- Codex describes each independent rollout serially after capturing one state
  snapshot.
- Canonical replacement resolves exact `(digest,text)` content once per text
  occurrence, even when the same pair has already been resolved in the current
  transaction.
- Obsolete-content deletion and affected FTS parity execute one statement per
  content ID.

Land phases 1–5 as ordered, independently reviewable changes. Phase 6 is an
evidence gate, not pre-authorized implementation: replacement transaction
batching, WAL tuning, and unchanged compare-and-set work require a separate
accepted plan only if the new measurements show one remains dominant.

## Changes

### 1. Add provider-free discovery and replacement measures

1. Add `scripts/measure-index-discovery.ts` with independent generated Cursor
   and Codex cohorts. It must not resolve a user provider or ordinary provider
   path.
   - Cursor mapping covers 2,000-agent/2,000-store and
     10,000-agent/10,000-store catalogs, forward/reverse store order,
     all-present, half-missing, repeated agent IDs, and duplicate directory
     names. Wrap the generated store array with a numeric-access counter so the
     scaling contract is observable without a production diagnostic API.
   - Codex covers 1, 8, 9, and 2,000 generated rollout descriptors in a random
     temporary root, including ready, missing, and invalid descriptors. Record
     serial production descriptor semantics, call count, result order, and
     elapsed discovery as the baseline. Concurrency, scheduling, and selected
     failure counters begin only after slice 3 introduces a controlled internal
     seam.
   - Emit only aggregate input/result counts, work counters, elapsed time, and a
     semantic equality flag. Never print IDs, names, locators, paths, hashes, or
     fixture text. Remove temporary roots in `finally`.
2. Add `scripts/measure-index-replacement.ts`. For every matrix row, create an
   isolated temporary Sessions library and use the production lifecycle,
   writer, and session-index port to start a run, seed shared content, apply
   replacements, finish, observe aggregate WAL bytes before close, close
   normally, and verify complete health and clean proof.
3. The replacement matrix covers:

   | Shape               | Sessions | Text occurrences | Unique exact pairs | Purpose                          |
   | ------------------- | -------: | ---------------: | -----------------: | -------------------------------- |
   | One wide unique     |        1 |           10,000 |               100% | Lookup/insert scaling            |
   | One wide mixed      |        1 |           10,000 |                50% | Local reuse                      |
   | One wide repetitive |        1 |           10,000 |                10% | Repeated-pair elimination        |
   | Many small          |      128 |              256 |               100% | Per-replacement transaction cost |
   | Many medium         |      128 |            8,192 |                50% | Transaction versus row work      |
   | Shared/reintroduced |       2+ |           10,000 |              mixed | Cleanup and sharing proof        |

   Require exact canonical documents, public digests, metrics, occurrences,
   representative search/entry results, run counts, receipt mutations, FTS,
   and post-close health. Use one disposable warm-up library and a fresh,
   independently but identically seeded production library for every timed
   iteration. Do not copy a closed clean seed: the proof binds file identity and
   stat. Assert equal schema, PRAGMA/security configuration, seed semantics,
   writer-open mode, receipt/generation baseline, page size, and freelist shape
   before timing. Report aggregate counts, unique/preexisting/missing pairs,
   inserted/deleted rows, affected IDs, replacement calls, receipt mutations,
   database/WAL bytes, and timing min/median/max. Keep collision,
   duplicate-exact-row, FTS mismatch, and forced rollback as correctness tests
   rather than timed rows.

4. Add `measure:indexing:discovery` and `measure:indexing:replacement` to
   `package.json`. Document both in `docs/contributing/testing.md` as generated,
   provider-free, aggregate-output diagnostics outside `pnpm check`; distinguish
   them from explicitly authorized live provider measures. Update
   `docs/contributing/indexing.md` with discovery-, occurrence-, unique-content-,
   and transaction-shaped work ownership.
5. Keep `scripts/measure-indexing.ts` unchanged as the stable, certified
   recovery, full-validation, missing-reconciliation, query, health, run, and
   clean-proof control. Add a small
   `scripts/support/indexing-measurement-runner.ts` owner for temporary-root
   creation, sanitized aggregate output, cleanup, and injected test failure.
   Cover it in `test/indexing-measurement.test.ts` with a tiny generated cohort,
   following only the sanitized spawn-failure pattern in
   `test/content-storage-measurement.test.ts`. The test rejects private output
   fields and proves cleanup without running the full performance matrix inside
   `pnpm check`.

### 2. Index Cursor agent stores once per catalog

1. `src/adapters/cursor/discovery.ts:mapCursorDiscovery` — build one
   `Map<string, CursorAgentStoreInventory>` with a single pass over each
   admitted catalog before iterating materialized agents. On duplicate
   `directoryName`, retain the first store and do not overwrite it, preserving
   current `.find` semantics. Continue validating directory/main/WAL kinds and
   using `claimedStores` by physical component key.
2. Preserve materialized-agent, candidate, and issue order; native-ID conflicts;
   unknown-catalog handling; claimed-store outcomes; catalog snapshotting;
   inventory passes; provider reads; fingerprints; and source-change detection.
   This phase changes only the in-memory join from O(A×S) to O(A+S).
3. `test/adapters/cursor/discovery.test.ts` — cover 2,000 and 10,000
   agent/store pairs with numeric store reads equal to store count; reverse
   order; duplicate names selecting the first store; repeated agents retaining
   `claimed-agent-store`; missing/invalid stores; unknown catalogs; duplicate
   native IDs; and exact binary candidate/issue order.
4. Update the discovery measure to require one store-array pass per catalog and
   exact equality with the recorded reference mapping. Do not change adapter
   version or public behavior.

### 3. Describe Codex rollouts with ordered bounded concurrency

1. Add `src/adapters/shared/ordered-concurrency.ts` by extracting the current
   Cursor helper into a provider-neutral internal adapter owner. Inputs receive
   original ordinals; active operations never exceed the caller limit; results
   return in input order; no new work starts after a visible failure;
   already-started work settles; and multiple failures select the lowest input
   ordinal. The helper does not log, expose input values, or try to cancel an
   in-progress filesystem call.
2. Move `src/adapters/cursor/inventory.ts` to the shared helper with its existing
   limit of eight and remove the old Cursor-owned helper. Move its tests to
   `test/adapters/shared/ordered-concurrency.test.ts`; cover empty, one, limit,
   limit+1, and large inputs, inverted completion, peak activity, no later
   scheduling, awaiting started work, and lowest-ordinal error selection.
3. `src/adapters/codex/source.ts` — add an internal
   `describeCodexRolloutsInOrder(threads, describe)` seam and replace the serial
   loop with the shared helper at a Codex-owned limit of eight. Production
   passes `describeRollout`; tests and the generated measure pass controlled
   descriptor operations. Each state thread receives exactly one descriptor
   call; `freezeCodexSession` stays paired with that thread; the result and
   generation `Map` retain state-thread order; and `currentGeneration` publishes
   only after every descriptor succeeds and the discovery-sequence guard passes.
4. Keep complete state snapshotting before descriptors, successful discovery
   over every state thread, read-time before/after rollout verification, and
   per-generation freshness unchanged. Do not cache descriptors across commands
   or generations and do not read transcript bodies during stable discovery.
5. `test/adapters/codex/source.test.ts` — cover 2,000 generated threads, exact
   state order, one descriptor per thread, mixed descriptor states, inverted
   completion, stable fingerprints, failure without partial generation
   publication, prior-generation invalidation, and provider-file byte equality.
   Slice 3 extends the discovery measure with controlled start/settle ordinals,
   peak concurrency, and selected failure ordinal, and requires calls equal to
   thread count, peak concurrency `min(8, count)`, serial semantic equality, and
   deterministic lowest-ordinal failure choice.

### 4. Resolve exact content once per replacement

1. Add `src/infrastructure/sqlite/sqlite-content-batch.ts` with a private fixed
   batch limit of 128. Three parameters per content pair remain below SQLite's
   minimum supported bind-variable limit; cleanup and parity reuse the row
   bound.
2. `src/infrastructure/sqlite/sqlite-session-document.ts:insertEntries` —
   collect first-seen unique exact content pairs before occurrence insertion.
   Use a nested map keyed first by validated digest and then exact binary text;
   digest alone or an ambiguous concatenated key is never identity. Keep
   occurrence-to-pair links in canonical order and retain no cache beyond the
   current replacement call.
3. Resolve unique pairs in 128-row
   `VALUES(input_ordinal,digest,text)` chunks joined to
   `sessions_content_values` on digest and `text COLLATE BINARY`. Order matches
   by input ordinal and `content_id`; more than one exact stored row is
   `corrupt-data`. Insert each missing exact pair once with the existing guarded
   `INSERT ... RETURNING`, keep signed SQLite IDs as `bigint`, then insert
   entries and occurrences in canonical order using resolved IDs.
4. Preserve the schema, digest index, exact-duplicate guard, FTS triggers,
   sharing across sessions, canonical readback, digest/metrics proof, one-session
   transaction, lease, and receipt boundary.
5. `test/infrastructure/sqlite-session-index.test.ts` — cover 257 pairs across
   chunks; 257 repetitions producing one content row and 257 occurrences;
   unequal text under a forced digest collision; preexisting, missing, repeated,
   shared, and reintroduced pairs; duplicate exact stored rows; and failure
   during insertion. A failed insertion rolls back all new content and
   occurrences, preserves last-good canonical state, leaves the failed
   replacement receipt unadvanced, and records only the existing separate
   `repository-write` mutation.
6. Update the replacement measure to require inserted content rows equal
   missing unique exact pairs rather than occurrences. Update
   `docs/contributing/storage.md` to describe transaction-local exact reuse, not
   a durable cache.

### 5. Batch cleanup and affected FTS parity

1. `src/infrastructure/sqlite/sqlite-content-maintenance.ts:deleteUnreferencedContentCandidates`
   — validate signed IDs, deduplicate in first-seen order, and replace one delete
   per ID with one conditional delete per 128-ID `VALUES` chunk. Delete only
   bound IDs that remain unreachable from all occurrences, use returned IDs or
   exact checked change counts, and never scan/delete unrelated orphan content.
   Keep the helper shared by replacement, forget, and repair.
2. `src/infrastructure/sqlite/fts-projection.ts:assertFtsProjectionContentParityForIds`
   — validate and deduplicate IDs, then compare canonical and FTS docsize
   presence once per chunk. Canonical-only and projection-only rows fail;
   both-absent rows after cleanup remain valid. Full doctor content/semantic
   checks remain unchanged.
3. Extend FTS and session-index tests across zero, negative, maximum signed,
   duplicate, and more than 128 IDs; obsolete/shared/reintroduced/unrelated
   content; and failure in a later chunk. Any cleanup or parity failure rolls
   back the whole replacement, preserves last-good state, and does not advance
   the failed transaction receipt.
4. Extend forget and repair tests to prove exact target deletion, shared-content
   retention, payload/window bounds, deleted row/byte counts, lease assertions,
   FTS triggers, and atomic rollback under the shared batch helper.
5. The replacement measure records affected IDs and expected cleanup/parity
   chunks and requires full semantic equality and health. Document bounded
   set-based cleanup/parity in `docs/contributing/storage.md`.

### 6. Re-measure and gate later architecture

1. After phases 1–5, run the three provider-free index measures and record
   before/after work counts and aggregates in `docs/architecture-memo.md`, with
   facts separated from hypotheses. Live Codex/Cursor measures remain optional,
   supplemental, and require the existing provider-read flag and authority.
2. Replacement transaction batching advances only through a separate plan when
   many-small/medium matrices show time dominated by replacement calls rather
   than row work. That plan must resolve bounded batch size, interruption,
   per-session rollback/replay and failure classification, result order,
   committed crash boundaries, and exactly one receipt advance per newly
   defined certified mutation. A whole-source transaction is prohibited.
3. WAL/checkpoint tuning advances only when WAL/checkpoint measurements remain a
   dominant cost and a generated crash experiment proves equal canonical, FTS,
   run, receipt, clean-proof, and recovery outcomes. Do not weaken
   `synchronous`, foreign keys, secure-delete, defensive mode, lease fencing,
   page reclamation, or sidecar recovery; consider only bounded connection-local
   checkpoint scheduling first.
4. Unchanged conditional compare-and-set advances only when `unchangedWrite`
   remains dominant after discovery work and a prototype can atomically require
   exact source/native identity and last-good fingerprint while asserting full
   input cardinality. Keep both the application freshness read and a
   transaction-time TOCTOU guard; one stale/missing/mismatched row rolls back the
   entire existing 128-item batch.
5. If none of these gates is met, mark all three deferred and end this program.

## Verify

- Run the focused Cursor discovery, shared concurrency, Codex source, SQLite
  session-index/FTS, forget, repair, writer coordination, and lifecycle tests
  after their owning phase.
- Run `pnpm measure:indexing`, `pnpm measure:indexing:discovery`, and
  `pnpm measure:indexing:replacement`; elapsed values remain report-only while
  exact work counts and semantic equality are required.
- Run `pnpm check` before publishing each independently reviewable phase.

## Boundaries

- Do not skip complete discovery, infer absence from an incomplete scan, cache a
  provider generation across commands, or remove source mutation verification.
- Do not parallelize transcript normalization or changed replacements in phases
  1–5.
- Do not change adapter versions, fingerprints, canonical schema, public output,
  or failure codes.
- Do not remove post-replacement reconstruction, document digest/metrics proof,
  affected FTS parity, lease fencing, or certified receipt behavior.
- Do not persist transcript-derived caches or emit transcript text, identities,
  locators, hashes, or paths from diagnostics.
- Do not change the existing replacement mutation boundary or tune WAL without
  the separate evidence-gated plan required by phase 6.
