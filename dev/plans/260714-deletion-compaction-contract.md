# Add explicit SQLite page reclamation

## Goal

Make physical file-size reclamation an explicit, bounded maintenance operation
without changing deletion semantics. `sessions forget` continues to delete the
selected canonical Sessions-owned data and make freed pages reusable; it does
not compact automatically or promise that the database file shrinks. The new
`sessions data compact [--format human|json]` command reclaims whole SQLite
freelist pages in fixed-size batches and reports only exact observed main-file
lengths.

This is a pre-launch baseline change, not a compatibility migration. It must
land after the separately reviewed compact-content baseline redesign (proposed
as `dev/plans/260714-compact-content-storage.md`). Rebase onto that merged work,
then update its resulting schema-1 bootstrap in place so content storage,
`auto_vacuum=INCREMENTAL`, and the `compact` lease purpose form one baseline and
one checksum. Do not create competing schema variants or a version-2 migration.
Existing development databases whose baseline or auto-vacuum mode differs fail
closed and require the already documented manual Sessions-library reset.

## Changes

1. `src/infrastructure/sqlite/sqlite-writer-database.ts:configureSqliteWriterDatabase`,
   `src/infrastructure/sqlite/migrations/0001-bootstrap.ts:bootstrapMigration`,
   `src/infrastructure/sqlite/permissions.ts:prepareIndexPathsForWriter`,
   `src/domain/index-state.ts`, and the lifecycle/health seams in
   `src/infrastructure/sqlite/database.ts`,
   `src/infrastructure/sqlite/read-snapshot.ts`, and
   `src/infrastructure/sqlite/sqlite-index-health.ts` — establish and enforce the
   new storage baseline. Have `prepareIndexPathsForWriter` return whether its
   existing exclusive `wx` reservation actually created the database, and pass
   that race-safe fact as an explicit `initializePageReclamation` flag. For that
   genuinely new file, issue `PRAGMA auto_vacuum = INCREMENTAL` and verify
   numeric mode `2` before the explicit WAL configuration and before any
   bootstrap table. For every file that already existed, read the mode before any
   storage-affecting pragma and reject both `NONE` (`0`) and `FULL` (`1`) without
   issuing the setter; a valid mode-`2` writer may proceed. Never run a full
   `VACUUM`, silently change an existing mode, or delete an incompatible file.

   Keep query enforcement and health diagnosis distinct. Add an internal
   read-snapshot option that defaults to enforcing mode `2`; ordinary query
   snapshots map a mismatch to an incompatible
   `page-reclamation-mode-mismatch` state and do not execute the query. The
   SQLite health inspector alone disables that enforcement after the existing
   safe-file and migration-history checks, reads the pragma in its callback, and
   returns exact `ReadyIndexHealth.pageReclamation: "incremental" | "invalid"`.
   Require `incremental` in the aggregate `ok` value and expose the same exact
   `pageReclamation` key/value through doctor, so a recognized mismatched
   library reports typed failed health instead of generic `inspection-failed`.
   In the rebased schema-1 bootstrap,
   extend the persisted writer-purpose constraint with `compact` and accept the
   resulting single checksum change alongside the compact-content redesign.
   Update `test/infrastructure/sqlite-lifecycle.test.ts`,
   `test/infrastructure/sqlite-reader-lifecycle.test.ts`, and
   `test/infrastructure/sqlite-index-health.test.ts` to prove a fresh database
   has mode `2` before/after bootstrap, a valid reopened WAL database remains
   usable, existing mode-`NONE` and mode-`FULL` databases fail closed without
   changing mode or file state, ordinary reads refuse the mismatch, and health
   plus doctor return `pageReclamation: "invalid"` rather than an inspection
   failure.

2. `src/application/ports/index-maintenance.ts`,
   `src/infrastructure/sqlite/writer-lease.ts`,
   `src/infrastructure/sqlite/writer-schema.ts`,
   `src/application/ports/index-health.ts`, and
   `src/infrastructure/state/index-state-diagnostic.ts` — add `compact` as a
   maintenance operation and exclusive writer-lease purpose. Expose
   `compact-live` through the existing lease-health/doctor contract, keep lease
   errors mapped to the existing sanitized busy/concurrent outcomes, and add a
   compact-specific operational failure code. Reuse the existing exact lease
   ownership, heartbeat, and `runLeasedImmediateTransaction` machinery. Renew
   the same identity inside every batch and immediately before each checkpoint;
   after a checkpoint, fence that identity again in an immediate transaction
   before continuing. A heartbeat covers time between synchronous steps, but
   the implementation must not claim that its timer runs during a blocking
   SQLite call: if a checkpoint outlives the lease and another generation wins,
   the post-checkpoint fence fails closed. Never hold one transaction for the
   entire command. Extend
   `test/infrastructure/sqlite-writer-coordination.test.ts` and
   `test/infrastructure/index-state-diagnostic.test.ts` for acquisition,
   heartbeat/renewal, contention, stale-lease recovery, and `compact-live`
   diagnosis using controlled clocks rather than elapsed-time assertions.

3. Add `src/infrastructure/sqlite/sqlite-index-compact.ts` and compose it from
   `src/infrastructure/sqlite/index-maintenance.ts`. Before opening SQLite,
   apply the existing canonical-path and owned-file checks so an absent library
   returns `absent` without creating directories, database/WAL/SHM files, or
   resolving a provider. For an owned, schema-valid, mode-`INCREMENTAL` library,
   acquire the `compact` writer lease and require a successful
   `PRAGMA wal_checkpoint(TRUNCATE)` result (busy count zero) before measuring the main
   database file. Read `page_size` and use a fixed internal 16 MiB budget to
   derive `max(1, floor(16 MiB / page_size))` pages per batch; expose no tuning
   flag. In each `runLeasedImmediateTransaction`, read the freelist, execute one
   bounded `PRAGMA incremental_vacuum(N)` when it is nonzero, and require the
   committed freelist count to decrease. After every committed batch, require
   another successful truncating checkpoint before continuing. Use the existing
   bounded SQLite busy timeout for checkpoint contention; do not add an
   unbounded wait. Finish only
   when the freelist is zero and the final checkpoint succeeds, then stat the
   main file again. A zero freelist yields `unchanged`; observed shrinkage yields
   `compacted`. Do not infer or promise reclamation from page counts: return the
   exact non-negative `databaseBytesBefore`, `databaseBytesAfter`, and
   `reclaimedDatabaseBytes` values from main-file lengths only.

   Each committed batch and checkpoint is durable progress. If lease renewal,
   strict progress, checkpointing, stat, or cleanup later fails, release/close
   safely, emit no success report, return a sanitized operational failure, and
   leave the already committed reclamation intact; rerunning must resume from
   the current freelist safely. Do not add full-`VACUUM`/`VACUUM INTO` fallback,
   free-space preflight, partial-page repacking, deletion-time compaction, or a
   forensic-erasure claim. Add
   `test/infrastructure/index-maintenance-compact.test.ts` with only generic
   temporary data to prove no-create absence, unchanged empty-freelist behavior,
   a seeded multi-batch large deletion, per-batch bounds and strict progress,
   WAL truncation, lease contention/renewal, injected partial failure plus safe
   rerun, and preservation of canonical rows and FTS consistency. Assert
   relative page/file progress and exact report arithmetic, not platform-specific
   byte totals or timing SLAs.

4. Add `src/application/compact-index.ts` and wire it through
   `src/cli/program.ts`, `src/cli/render.ts`, `src/cli/run.ts`, and
   `src/bin/sessions.ts`. The versioned JSON object is exactly:

   ```ts
   {
     schemaVersion: 1,
     command: "data-compact",
     outcome,
     databaseBytesBefore,
     databaseBytesAfter,
     reclaimedDatabaseBytes,
   }
   ```

   `outcome` is `absent | unchanged | compacted`; absent reports three zeroes. Human output
   states the same outcome and exact aggregate byte values without paths,
   page/freelist estimates, content, or provider details. The command requires
   no `--yes`, accepts only the shared human/JSON format option, and does not
   resolve source adapters. Preserve the CLI contract: success is exit 0 on
   stdout; an active lease or any compact operational failure is sanitized exit
   1 on stderr with no stdout; parse/usage failures remain exit 2. Add focused
   application coverage and extend `test/cli.test.ts`,
   `test/cli-render.test.ts`, and `test/provider-lazy-resolution.test.ts` for the
   exact schemas, streams/exits, no-confirmation syntax, busy/failure handling,
   and provider-free absent/no-create behavior.

5. `README.md`, `docs/architecture-memo.md`,
   `docs/contributing/architecture.md`, `docs/contributing/commands.md`,
   `docs/privacy.md`, `docs/reference/cli-contract.md`, and
   `dev/plans/260713-v1-implementation-roadmap.md` — document current behavior
   only when the implementation lands: logical forget makes pages reusable but
   does not shrink the file; compact is the explicit whole-free-page reclamation
   route; partial durable progress can remain after a failed run and a rerun is
   safe; exact reported bytes are observed main-file lengths, not promised
   savings; WAL checkpoints may wait/fail on contention; and neither
   `secure_delete` nor compaction claims encryption or forensic erasure. Add the
   command/output/error schemas and mark this storage hardening complete in the
   roadmap without changing provider-read, data-clear, or orphan policy.

## Verify

- `pnpm test test/infrastructure/sqlite-lifecycle.test.ts test/infrastructure/sqlite-reader-lifecycle.test.ts test/infrastructure/sqlite-index-health.test.ts test/infrastructure/sqlite-writer-coordination.test.ts test/infrastructure/index-state-diagnostic.test.ts test/infrastructure/index-maintenance-compact.test.ts`
- `pnpm test test/application/compact-index.test.ts test/cli.test.ts test/cli-render.test.ts test/provider-lazy-resolution.test.ts`
- `pnpm check:docs`
- `pnpm check`

## Boundaries

- Do not start implementation until the compact-content baseline redesign is
  merged; rebase and reconcile the one schema-1 bootstrap/checksum first. Stop
  for architecture review if that dependency changes the shared schema or lease
  assumptions described here.
- No compatibility migration, schema version 2, automatic reset, full `VACUUM`,
  `VACUUM INTO`, temp-space guarantee, configurable batch size, threshold policy,
  or compaction during index/forget/clear.
- No canonical content redesign, orphan detection/repair, metadata-retention
  change, provider mutation, telemetry/network dependency, encryption promise,
  forensic-erasure claim, or guaranteed reclaimed-byte amount.
