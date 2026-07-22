# Streamline provider discovery I/O

## Goal

Remove three measured sources of avoidable provider-discovery work without
changing a candidate, fingerprint, failure, or read-only guarantee:

- Codex currently executes one spawn-edge query per thread, which becomes
  quadratic when the provider table has no child-edge index;
- the shared SQLite snapshot reads every provider main/WAL byte three times per
  attempt even though copy-time and post-copy digests provide the acceptance
  proof; and
- Cursor's two required structural inventories process independent leaf grammar
  nodes serially.

After this change Codex uses one ordered edge scan, each successfully admitted
provider SQLite snapshot uses exactly two full byte passes (copy while hashing,
then post-copy hash), and Cursor admits at most eight independent inventory
leaves concurrently while merging every result and failure in the original
binary order. Candidate
observations, aggregate fingerprints, adapter versions, normalized documents,
provider failure kinds, snapshot retry bounds, and provider bytes/metadata must
remain exact. No application port, canonical schema, CLI, or structured-output
change.

## Changes

1. `src/adapters/codex/state-db.ts:materializeCodexState` — retain the current
   schema detection and binary thread query, but replace the prepared
   child-by-child edge statement with one set query. Join
   `thread_spawn_edges` to
   `SELECT DISTINCT id COLLATE BINARY AS admitted_child_id FROM threads`, select
   that binary-distinct admitted ID as the grouping key, and order by admitted
   child ID then parent ID with binary collation. In the join predicate, keep
   `thread_spawn_edges.child_thread_id` on the left of `=` so SQLite applies the
   edge column's declared collation exactly as today's
   `WHERE child_thread_id = ?` point query does. Select `status` only when the
   capability is present.

   Materialize raw edge groups once, then preserve current per-thread processing
   order: validate that thread's fields, validate its zero/one related edge and
   exact child ID/status, construct the existing `edgeTuple`, and only then
   apply duplicate-thread detection. The set query must ignore unrelated/orphan
   edge rows just as today's point query does. Preserve table-absent `unknown`
   coverage, supported-table row absence as `complete`, exact status capability
   tags, multiple-parent `malformed`, binary thread order, and every row/edge
   tuple byte. Remove the `StatementSync` dependency and private point
   `readEdge`; do not bump the adapter version because admitted evidence is
   unchanged.

2. `test/adapters/codex/state-db.test.ts` — keep the existing exact tuple,
   status-present/absent, table-absent, row-absent, multiple-parent,
   duplicate-thread, and order cases. Add a large generic generation (at least
   2,000 threads) with an instrumented database statement seam and require one
   edge-query execution, not one per thread. Add a malformed orphan edge whose
   child is not in the thread cohort and prove it remains ignored; malformed
   edges for an admitted child must still fail in that child's deterministic
   position. Add accepted schemas where `threads.id` and, separately,
   `thread_spawn_edges.child_thread_id` use non-binary collations; prove
   case-distinct thread IDs remain distinct, exact edge tuples match the point
   behavior, and a collation match with a non-exact returned child still fails
   as malformed.

3. `src/adapters/shared/sqlite-source-snapshot.ts:captureAttempt` — remove
   `HashedProviderFile`, `hashProviderFiles`, and the initial full-provider hash.
   Pass the initially opened, identity-checked handles directly to
   `copyProviderFiles`, retain the digest already produced while copying, and
   require that digest to equal the post-copy digest from a freshly opened
   provider set.

   Keep every other stability check: exact main/optional-WAL set and order,
   unchanged original path and handle identities, matching reopened path and
   handle identities, a defined copied digest for each file, no-follow read-only
   provider handles, private mode-0600 copies, no provider SHM access, private
   SHM cleanup, three bounded attempts, and existing sanitized failure/cleanup
   precedence. The post-copy byte hash is mandatory; never replace it with
   metadata alone. A snapshot is admitted only when copied bytes equal one
   complete stable post-copy provider generation.

   Extend the existing internal test hook with a sanitized observation naming
   only attempt, `copy`/`verify` phase, and `database`/`wal` kind so tests can
   count byte passes. The hook must expose no path, size, identity, digest, or
   content. It remains an internal deterministic test seam and must not change
   production failure mapping except when a test deliberately throws from it.

4. `test/adapters/shared/sqlite-source-snapshot.test.ts` — require exactly one
   copy and one verification pass for each main/WAL file only on an attempt
   whose initial and reopened provider sets match and reach byte verification.
   A set-length/kind mismatch may and should short-circuit before post-copy
   hashing once instability is proven; it must retry without materializing the
   mixed generation. Keep the existing main-only, active-WAL, zero-byte main,
   replacement, append/truncate, checkpoint, WAL disappearance, three-retry,
   provider-SHM non-use, private cleanup, concurrent-generation, and
   provider-tree immutability cases authoritative. Add the missing deterministic
   WAL-appearance case: create the WAL between initial open and post-copy
   verification, prove that attempt is rejected without materialization, and
   accept only a later stable main/WAL attempt. Add a deterministic
   copy/post-copy mutation case if the existing hook matrix does not already
   prove that equal identity metadata cannot admit unequal bytes.

5. Add `src/adapters/cursor/ordered-concurrency.ts` with an internal fixed
   `CURSOR_FILESYSTEM_CONCURRENCY = 8` and
   `mapCursorInventoryInOrder(inputs, operation)`. Use monotonic-index workers,
   store results and failures by input ordinal, stop assigning new work after
   any failure is observed, await every already-started operation, and throw the
   lowest-ordinal failure. Successful output is frozen in input order. This
   avoids settlement-order failures, abandoned file operations, nested
   unbounded `Promise.all`, and an exposed concurrency setting.

6. `src/adapters/cursor/inventory.ts` — refactor only independent leaf work into
   local fragments and schedule, at one level at a time:

   - chat directories within one binary-sorted chat scope;
   - agent-store directories within one catalog scope; and
   - transcript identity directories within one transcript root.

   Each leaf returns its own ordered descriptor entries and mapped inventory
   values. Flatten fragments in original input order so the complete descriptor
   sequence, structural fingerprint, candidates, invalid-entry order, and
   failure precedence remain byte-for-byte equivalent on a stable tree. Keep
   parent scope/project traversal, catalog SQLite materialization, the first and
   second complete inventories, and changed-session reads sequential. Do not
   nest pools; global inventory leaf concurrency and concurrently open metadata
   files must never exceed eight. Preserve SHM exclusion before scheduling,
   opaque-component grammar, symlink/no-follow behavior, stat/digest checks, and
   second-inventory source-change detection.

7. Add `test/adapters/cursor/ordered-concurrency.test.ts` and extend
   `test/adapters/cursor/discovery.test.ts`. At the helper seam, prove the active
   bound never exceeds eight, reverse completion still returns input order, a
   later failure observed first loses to a lower-ordinal started failure, all
   started work settles, and no later input is assigned after a failure is
   observed. At the adapter seam, use more than eight generic leaves in each
   parallel family and require repeated inventory fingerprints, descriptor
   order, candidate/invalid-entry order, sidecar exclusion, provider-tree
   immutability, and source-change classification to remain exact.

8. `docs/contributing/testing.md`, `docs/contributing/architecture.md`, and the
   cross-cutting maintenance section of `docs/architecture-memo.md` — document
   the now-current set edge query, copy-hash/post-hash snapshot proof, and fixed
   ordered Cursor concurrency. Record only generic aggregate before/after
   evidence after deterministic verification. Keep provider histories
   read-only and do not describe local timings as release budgets.

9. After focused tests and `pnpm check`, optionally run the existing production
   discovery measurements only with fresh explicit authority to read local
   provider histories:

   - `pnpm measure:indexing:codex -- --allow-provider-read`
   - `pnpm measure:indexing:cursor -- --allow-provider-read`

   Compare aggregate `sourceDiscovery` and changed-read timings while retaining
   the scripts' complete cohort equality, stable zero-read, provider-byte
   equality, report, health, workspace, redaction, and cleanup gates. Do not
   commit live output and do not add a machine-time threshold.

## Verify

- `pnpm test test/adapters/codex/state-db.test.ts test/adapters/shared/sqlite-source-snapshot.test.ts test/adapters/cursor/ordered-concurrency.test.ts test/adapters/cursor/discovery.test.ts test/adapters/codex/source.test.ts test/adapters/cursor/source.test.ts test/adapters/codex/source-contract.test.ts test/adapters/cursor/source-contract.test.ts`
- `pnpm check`

## Boundaries

- Do not mutate provider files, pass provider SQLite paths to SQLite, copy SHM,
  relax the post-copy byte proof, increase the three-attempt retry bound, or
  expose paths/digests through hooks or diagnostics.
- Do not parallelize source instances, catalog snapshots, changed reads,
  normalization, or persistence; do not nest concurrency pools or add a public
  concurrency flag.
- Do not change candidate tuples/fingerprints, adapter versions, format support,
  failure classes/order, discovery completeness, or stable inventory order.
- Live provider measurements require explicit authority and supplement rather
  than replace generic deterministic proof.
- STOP if the bulk Codex query observes an edge the point path ignored, copied
  bytes cannot be proven equal to one stable post-copy generation, or concurrent
  Cursor inventory differs from the serial binary-order contract.
