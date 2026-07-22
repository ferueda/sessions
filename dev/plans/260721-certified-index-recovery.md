# Certify crash-safe index generations

## Goal

Let a later index writer recover an expired index generation without rescanning
the whole canonical library when every committed mutation in that generation
already passed the same local postconditions required for a normal clean close.
This is a proof optimization, not sampled validation and not continuation of an
interrupted run. The abandoned run is still interrupted and the new invocation
still discovers and indexes from the beginning.

Add a durable, transaction-bound receipt for index generations. SQLite crash
recovery supplies transaction atomicity; the receipt proves that supported
Sessions writes reached only certified commit boundaries. An exact expired
index lease plus matching receipt may use constant-size schema and FTS structure
checks after SQLite recovers its WAL. Missing, stale, malformed, wrong-purpose,
migration-era, or structurally unsafe evidence must use today's full canonical,
foreign-key, and FTS validation/repair path. `doctor` remains the explicit
read-only whole-library semantic audit.

Implement this after
[`260721-bounded-incremental-indexing.md`](260721-bounded-incremental-indexing.md)
so the final batch mutation surface is certified once. The change must preserve
all reports, retained evidence, queries, failure truth, provider-read-only
behavior, normal clean-proof behavior, and recovery fallback correctness.

## Recovery receipt

Index schema 3 adds one strict singleton row with receipt format version 1, the
certified writer generation, schema version, schema cookie, and monotonically
increasing safe-integer operation sequence. A row means only that the named
active/abandoned index generation has passed every supported mutation boundary;
it contains no timestamp, source, session, path, fingerprint, content hash,
transcript, lease token, or timing data.

Receipt eligibility is exact:

1. the pre-acquisition lease is expired, still names purpose `index`, and has
   the same generation as the receipt;
2. the receipt names the current schema version and pre-acquisition schema
   cookie, with no pending or just-applied migration;
3. SQLite has recovered any ordinary WAL state, the library/migration/lease
   catalog is valid, and the normal constant-size FTS structure check passes;
4. acquisition atomically interrupts abandoned active runs and clears the old
   receipt before advancing ownership; and
5. after all open-time checks and configuration succeed, the new exact index
   owner writes its own sequence-zero receipt in a leased transaction.

The clean post-close proof remains preferred for a normal free generation. A
receipt beside a free lease, maintenance lease, live owner, changed schema, or
invalid FTS structure is never enough. Those cases fall back to full validation;
successful full validation may then initialize the new generation's receipt.
Only an already proven clean/certified base or the complete full-validation path
may establish a receipt. Local mutation checks may advance an existing receipt;
they must never manufacture trust from an unproven library.

Existing lifecycle precedence remains intact: a live lease is busy; an expired
`clear` lease is resumable only by clear; unsafe, incompatible, newer-schema, or
orphan-sidecar state keeps its current fail-closed result; and a new database
uses bootstrap. Ordinary WAL recovery attached to an exact expired index lease
is the certified-recovery target, not a reason to ignore those states.

## Changes

1. `src/infrastructure/sqlite/migrations/0003-index-generation-receipt.ts`,
   `src/infrastructure/sqlite/migrations.ts`, and
   `test/infrastructure/sqlite-canonical-migration.test.ts` — add the schema-3
   strict singleton receipt table and register a data-preserving migration.
   Do not backfill a receipt: the first schema-3 writer must reject its old clean
   proof due to the schema change, run full validation, and create a receipt only
   after that validation succeeds. Prove schema-2 canonical/tracking/run/FTS
   state and digests survive migration unchanged, a failed migration rolls back,
   and no receipt is manufactured from unvalidated legacy state.

   Treat this table as rebuildable operational proof, not canonical evidence.
   Add an exact structure validator. If the table DDL is missing or altered,
   repair only this table inside owned recovery, then require the complete
   canonical/foreign-key/FTS proof before inserting a new row. A malformed row
   in an exact table is merely ineligible and may be replaced only after full
   validation. If exact isolated repair cannot be proved, fail closed.

2. Add `src/infrastructure/sqlite/writer-recovery-receipt.ts` as the sole owner
   of receipt decoding and mutation. It must:

   - inspect a prior receipt against a locked pre-acquisition lease, schema
     version, and schema cookie;
   - clear prior evidence in the same transaction that acquires the next
     generation;
   - initialize sequence zero only for the exact live index owner after writer
     setup has succeeded;
   - assert exact generation/schema ownership and increment the sequence by one
     in the same transaction as every certified index mutation; and
   - fail closed on missing, duplicate, malformed, non-safe-integer, stale, or
     wrong-generation data.

   Keep heartbeat timestamps outside the semantic receipt: they are
   coordination-only writes fenced by the same generation. Receipt APIs must
   require the existing `WriterLeaseIdentity`; no caller supplies a generation
   or sequence by scalar value.

3. `src/infrastructure/sqlite/writer-lease.ts:acquireWriterLeaseRow`,
   `src/infrastructure/sqlite/writer-schema.ts:acquireWriterSchema`, and
   `src/infrastructure/sqlite/database.ts:openWriter` — evaluate the prior
   receipt while the acquisition transaction still sees the old lease, return
   a typed certified-recovery candidate, and clear it as ownership advances.
   Recheck migration history and schema cookie after migrations. Select exactly
   one open mode in this order: clean `fast`, `certified-recovery`, `bootstrap`,
   or `full-validation`.

   A certified recovery performs the same constant-size catalog and FTS
   structure checks as a clean fast open and skips global canonical,
   foreign-key, FTS content, and FTS semantic scans. If any bounded check fails,
   discard eligibility and run the complete existing
   `repairFtsProjection` path; do not partially trust the receipt or rebuild FTS
   from uncertified canonical rows. Open the capture workspace and configure
   persistent FTS settings first, then initialize the current generation receipt
   as the last integrity-bearing setup mutation before returning the writer.
   Heartbeat renewals remain the explicitly excluded coordination writes. A
   crash anywhere earlier therefore leaves no reusable receipt.

4. `src/infrastructure/sqlite/sqlite-session-index.ts` — replace its two
   transaction helpers with one certified leased transaction wrapper for every
   durable index mutation: `startRun`, bounded unchanged, ordinary failure,
   canonical replacement, replacement-failure recording, bounded missing, and
   `finishRun` including run retention. The wrapper must renew/assert the exact
   lease at entry and exit, execute the existing operation-specific
   postconditions, then advance the receipt before the same commit. A thrown
   operation or receipt error rolls back both the mutation and sequence advance
   and retains the existing in-memory integrity-uncertain behavior. No supported
   index data write may bypass this wrapper.

   Add a narrow architecture/allowlist assertion in `test/architecture.test.ts`
   for index-purpose persistent transaction owners so a later direct
   `runImmediateTransaction`/`runLeasedImmediateTransaction` call cannot silently
   bypass certification. The operation sequence is audit evidence, not a way to
   detect an omitted wrapper after the fact.

   Acquisition's abandoned-run interruption and normal close's run interruption
   remain special lease transitions with exact affected-state assertions. A
   normal close still seals and publishes the stronger stat-bound clean proof;
   a receipt left beside the resulting free lease is deliberately ineligible.
   Forget, repair, compact, and clear remain uncertified and force the existing
   full path on the next index open.

5. `src/application/index-progress.ts`, the runtime/CLI progress renderer, and
   their focused tests — add the internal `certified-recovery` writer-open mode
   and an honest bounded interactive message. It must not claim the library was
   fully scanned, recovered an interrupted run, or verified arbitrary external
   edits. Keep redirected stderr quiet and progress best-effort. Existing timing
   phases remain fixed: a certified recovery is observable through
   `writerOpen` plus its mode and records zero calls for every full-validation
   phase.

6. Add `test/infrastructure/sqlite-writer-recovery-receipt.test.ts` and extend
   `test/infrastructure/sqlite-writer-coordination.test.ts`,
   `test/infrastructure/sqlite-lifecycle.test.ts`, and
   `test/infrastructure/sqlite-fts-repair.test.ts` with the eligibility matrix.
   Prove:

   - each successful mutation class advances exactly one sequence in the same
     transaction, while a forced operation/postcondition/commit failure advances
     neither state nor receipt;
   - a crash before acquisition commit preserves the prior eligible generation;
     a crash after acquisition clears the old receipt but before sequence zero
     forces full validation; and a crash after sequence zero permits certified
     recovery;
   - raw process-style close after certified commits leaves an expired exact
     index generation that reopens as `certified-recovery` after lease expiry,
     interrupts its active run, and emits no full-validation phase;
   - a crash inside a mutation rolls back both mutation and sequence; a crash
     after their shared commit retains both; a crash before full validation
     establishes its first receipt repeats the full path;
   - missing/wrong generation, wrong schema cookie/version, malformed receipt,
     free dirty state, live lease, maintenance purpose, pending/applied
     migration, setup failure, a normally released dirty generation, and a newer
     ownership generation cannot use the receipt;
   - invalid FTS structure routes through full canonical/FK/FTS validation and
     repair, while valid certified FTS state is not scanned globally; and
   - missing/altered receipt-table structure is isolated and rebuilt before a
     required full proof, while unsafe repair fails closed; and
   - a stale owner cannot advance, initialize, clear, or clean a newer
     generation's evidence.

7. `test/application/run-index.sqlite.test.ts` and
   `scripts/measure-indexing.ts` — build equal generic clones that perform the
   same committed index work. Close one normally and abandon the other's raw
   SQLite handle at a certified transaction boundary with a deterministic
   non-running heartbeat scheduler; after lease expiry, run the same stable
   index again. Require equal public reports and capture scope, canonical
   documents/digests/metrics, tracking outcomes, list/search/entries and FTS
   results, full doctor health, zero stable provider reads, and final clean
   proof. Assert operational generation and abandoned-run interruption
   differences separately rather than requiring diagnostic rows to be equal.
   The abandoned clone must report `certified-recovery` with zero global
   validation calls.
   Keep a separately receipt-invalidated clone that still exercises the exact
   full-validation fallback and remains semantically equal. Report aggregate
   timings without a release threshold.

8. Add `docs/decisions/0011-certify-index-generation-recovery.md` and update
   `docs/decisions/README.md`, `docs/contributing/indexing.md`,
   `docs/contributing/testing.md`, `docs/contributing/architecture.md`,
   `docs/contributing/storage.md`, `docs/contributing/maintenance.md`,
   `docs/reference/cli-contract.md`, `docs/privacy.md`, and the writer-open and
   cross-cutting maintenance sections of `docs/architecture-memo.md`. Record the
   state machine, schema-3 migration, eligible/fallback matrix, and the accepted
   threat boundary: like the clean fast path, a supported-operation receipt
   does not detect arbitrary same-user, same-schema out-of-band edits. Keep
   current behavior and planned behavior distinct until the implementation and
   equality measurement pass.

## Verify

- `pnpm test test/infrastructure/sqlite-canonical-migration.test.ts test/infrastructure/sqlite-writer-recovery-receipt.test.ts test/infrastructure/sqlite-writer-coordination.test.ts test/infrastructure/sqlite-lifecycle.test.ts test/infrastructure/sqlite-fts-repair.test.ts test/application/run-index.sqlite.test.ts`
- `pnpm measure:indexing`
- `pnpm check`

## Boundaries

- Do not sample canonical rows, accept a receipt with a free/maintenance/live
  lease, or use a receipt after migration or failed bounded structure checks.
- Do not resume an interrupted run, checkpoint a whole-library validation scan,
  retain provider/session identifiers in the receipt, or weaken `doctor`.
- Do not certify forget, repair, compact, or clear in this change.
- Do not claim protection from direct database edits, malware, disk loss, or
  another process running as the same user; those remain outside the supported
  trust boundary.
- STOP if any supported index mutation cannot advance the receipt atomically
  after its local postconditions, if a crash point can expose a partially
  committed operation as certified, or if the forced full-validation control
  and certified recovery disagree on retained/public results.
