# Expose and repair orphaned canonical content

## Goal

Add exact, privacy-safe orphan visibility to the immutable library health report
and one explicit provider-free `sessions data repair-orphans` operation that
removes all currently unreachable canonical text through bounded SQLite
transactions. This is resilience for historical or unexpected state: the
audited library had zero orphan rows/bytes and no FK or FTS mismatch, and no
normal orphan producer is known.

Implement this plan only after the compact-content baseline and the compaction
lease extension have landed. Rebase onto both, preserve their accepted schema
and lease decisions, and then extend that clean baseline with `repair` ownership.
The command must finish the current repair pass in one invocation; fixed internal
batches bound each transaction/WAL interval, while committed batches make an
interrupted or failed invocation safe to rerun from the beginning.

Acceptance requires aggregate-only doctor and repair output, an explicit
`repair`/`repair-live` operational identity, candidate-scoped forget cleanup,
and no change to the behavior or transaction order of PR #14's replacement hot
path. Logical deleted text bytes are not physical disk reclamation.

## Changes

1. `src/infrastructure/sqlite/migrations/`, `migrations.ts`,
   `writer-lease.ts`, `writer-schema.ts`, and
   `src/application/ports/index-health.ts` — after reconciling the prerequisite
   storage changes, add persisted `repair` writer ownership to their resulting
   clean baseline and expose live ownership as `repair-live`. Repair is a
   distinct command identity: do not borrow `index`, `forget`, or `clear`, and
   do not add a lease-only compatibility path for the superseded pre-launch
   baseline. Preserve generation fencing, ordinary expired takeover,
   transaction-entry/exit renewal, heartbeat failure handling, and the special
   clear-only destructive-intent rule. Extend the migration, lease-coordination,
   and ready-health integration seams to prove exact `repair` persistence,
   mutual exclusion, takeover, release, and sanitized `repair-live` reporting.

2. `src/infrastructure/sqlite/sqlite-index-health.ts`,
   `src/infrastructure/state/index-state-diagnostic.ts`, and
   `test/infrastructure/sqlite-index-health.test.ts` — inspect canonical content
   reachability inside the existing immutable ready-library snapshot. Define an
   orphan exactly as a canonical content row with no content occurrence; compute
   exact row count and `length(CAST(text AS BLOB))` UTF-8 bytes with one content
   scan and covering-index occurrence probes. Add machine-facing
   `contentReachability: ok | orphaned | inspection-failed` plus decimal-string
   `orphanContentRows` and `orphanContentBytes` (`unknown` only when inspection
   fails). Nonzero or unavailable reachability makes the library/doctor
   unhealthy without changing the independent meanings of canonical integrity,
   foreign keys, FTS structure/content/secure-delete, or FTS remediation. Seed
   generic orphan text to prove doctor detects aggregate rows/bytes while FK and
   FTS checks can remain healthy, emits no content/IDs/hashes/paths, and leaves
   database bytes, sidecars, migrations, runs, and filesystem state unchanged.

3. `src/application/ports/index-maintenance.ts` and a focused application
   service such as `src/application/repair-orphaned-content.ts` — add one
   provider-neutral maintenance operation and schema-1 report. The public report
   is exactly command `data-repair-orphans`, outcome `repaired | unchanged`, and
   exact non-negative decimal-string aggregates `deletedContentRows` and
   `deletedContentBytes`; it contains no scanned-row metric, partial outcome,
   cursor, batch limit, oversize flag, content locator, or physical-reclamation
   claim. A missing library is `unchanged` with zero counts and no state creation.
   Preserve committed-batch durability but emit no success report after an
   operation/lease/cleanup failure; map busy, unsafe/non-ready, corrupt, and FTS
   candidate failures to sanitized operational exit 1. The explicit command is
   sufficient deletion intent and does not require `--yes`.

4. Add a focused SQLite repair implementation under
   `src/infrastructure/sqlite/` and compose it through
   `createSqliteIndexMaintenance`. Acquire and heartbeat one `repair` lease for
   the whole invocation and loop in ascending keyset order until no rows remain.
   Keep the continuation `content_id` only in memory as a nullable signed-64-bit
   BigInt: omit the lower-bound predicate for the first window, enable BigInt
   reads for candidate IDs, and bind later cursors unchanged without arithmetic.
   Each
   `runLeasedImmediateTransaction` reads an ascending window of at most 10,000
   existing content rows after the cursor and selects orphan candidates from that
   window in the same order until adding another would exceed 64 MiB of logical
   UTF-8 payload; make both limits injectable only through infrastructure test
   options. If every candidate in the window is selected, advance to the window's
   last content ID; if the byte budget truncates the candidates, advance only to
   the last selected content ID so no later row is skipped. A window with no
   candidate still advances to its last content ID. Permit the first candidate
   even when it alone exceeds the byte budget so every batch advances. Inside
   every batch, require the recognized current schema, enabled FK enforcement, applicable
   secure-delete policy, and the exact FTS table/shadow/trigger structure. For
   every selected deletion, prove no occurrence and a matching FTS docsize row,
   repeat the `NOT EXISTS` guard in the delete, and verify both canonical and FTS
   candidate rows disappeared. Any mismatch, trigger/delete/postcondition error,
   or lease loss rolls back that whole batch. Do not run a whole-library
   canonical/FK/FTS-content preflight per batch and never rebuild FTS; unrelated
   damage remains doctor's responsibility, while existing delete triggers keep
   the selected derived row synchronized.

5. Extract the former-content candidate capture and guarded unreferenced-delete
   helpers introduced by PR #14 from
   `src/infrastructure/sqlite/sqlite-session-document.ts` into one focused
   provider-neutral SQLite content-maintenance module, then reuse them from
   replacement, forget, and repair. The extraction must not change replacement
   SQL shape, candidate set, call order, transaction ownership, or regression
   expectations. In `sqlite-index-forget.ts`, capture the forgotten session's
   distinct former content IDs before cascade and delete only those still
   unreferenced afterward; remove its whole-library anti-join sweep so unrelated
   historical orphans belong exclusively to explicit repair. Extend
   `test/infrastructure/index-maintenance-forget.test.ts` to prove target-only
   cleanup, shared-content retention, unrelated-orphan preservation, FTS
   synchronization, and rollback under the existing forget lease.

6. `src/cli/{program,run,render}.ts`, `src/bin/sessions.ts`, CLI/process tests,
   `README.md`, `docs/architecture-memo.md`, `docs/reference/cli-contract.md`,
   `docs/privacy.md`, `docs/contributing/{architecture,commands}.md`, and
   `dev/plans/260713-v1-implementation-roadmap.md` — add only
   `sessions data repair-orphans [--format human|json]`, wire the existing
   maintenance instance without resolving/probing a source, and render aggregate
   totals with logical-byte wording. Generated help and the CLI contract must
   expose no `--limit`, `--cursor`, continuation, partial-success, or automatic
   repair behavior. Contract tests cover exact human/JSON output, exit 0 for
   repaired/unchanged, exit 1 sanitization, no provider resolution, and no
   persistence for an absent library. Document doctor → explicit repair → doctor
   as the operability flow, FTS rebuild as separate index-owned behavior, and
   prerequisite-owned physical compaction as an existing separate operation;
   only metadata-retention work remains future. Reconcile every current
   command/maintenance inventory, the accepted architecture's no-public-repair
   and lease-purpose statements, and the roadmap's current-state summary so they
   record provider-free aggregate orphan deletion plus `repair`/`repair-live`
   ownership only after the implementation lands.

7. Add a real SQLite repair integration suite at the maintenance boundary. Use
   only synthetic temporary libraries to prove zero-orphan idempotence, multiple
   committed batches, row and byte budget boundaries, one oversize-row progress,
   interruption/failure followed by restart from the beginning, live/expired
   writer coordination, FTS candidate mismatch rollback, trigger synchronization,
   and exact aggregate totals across the whole invocation. Seed matching FTS rows
   for orphan content IDs below zero, at zero, and above
   `Number.MAX_SAFE_INTEGER` to prove full signed-64-bit ordering and deletion.
   Retain PR #14's unrelated-orphan replacement regression unchanged; do not add
   wall-clock assertions or inspect live provider/Sessions libraries.

## Verify

- `pnpm exec vitest run test/infrastructure/sqlite-index-health.test.ts test/infrastructure/index-maintenance-forget.test.ts test/infrastructure/index-maintenance-repair-orphans.test.ts test/cli.test.ts`
- `pnpm check:docs`
- `pnpm check`

## Boundaries

- STOP if either prerequisite changes canonical reachability or lease semantics
  incompatibly with this plan; reconcile the plan before implementation rather
  than layering assumptions from `9e9ade5` onto the new baseline.
- No per-replacement or once-per-writer whole-library sweep, and no behavioral
  change to candidate-scoped replacement.
- No public progress events, limits, cursors, partial DTOs, resume tokens, or
  timing fields. Fixed batches are an internal transaction/WAL bound, not a
  promise that one invocation is short.
- No FTS rebuild, provider access/mutation, telemetry, network dependency,
  metadata retention, VACUUM/compaction, file shrink, or reclaimed-disk metric.
- Docs, reports, fixtures, tests, and review evidence remain aggregate-only and
  generic; never use private transcripts, paths, identities, hashes, or content.
