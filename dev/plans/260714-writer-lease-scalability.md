# Make writer leases safe for long SQLite transactions

## Goal

Let `sessions index` open and refresh a large retained library without losing its
30-second writer lease while synchronous canonical/FTS validation blocks the
event-loop heartbeat. Preserve single-writer fencing: an expired exact owner may
recover only after obtaining `BEGIN IMMEDIATE` and only when no competing
takeover changed its generation/purpose/token; a stale owner must never commit.

Acceptance requires deterministic race/rollback proofs and a repeat index of the
current local library that completes with at least one unchanged session. The
live check may report aggregate counts only; no provider paths, IDs, or transcript
content enter logs or fixtures.

## Changes

1. `src/infrastructure/sqlite/writer-lease.ts` — add a single internal-facing
   leased immediate-transaction primitive beside `assertWriterLease` and
   `heartbeatWriterLease`. It must:

   - acquire `BEGIN IMMEDIATE` before deciding whether an expired owner can
     recover;
   - require the exact generation, purpose, and token, preserve the existing
     backward-clock rejection, and renew `heartbeat_at`/`expires_at` at
     transaction entry even when that exact row has expired;
   - run the synchronous body, then require the same exact identity and renew
     again immediately before commit, allowing the body itself to cross expiry;
   - roll back the entry renewal and all body writes if the body, ownership
     check, clock check, or final renewal fails.

   Reuse the existing transaction and lease-row helpers rather than duplicating
   lease SQL. Keep ordinary assertions, timer heartbeats, acquisition, release,
   clear-lease handling, and outside-transaction expiry semantics unchanged. If
   a competing writer committed takeover first, its new generation/token must
   make the old owner's transaction fail before its body runs.

2. `src/infrastructure/sqlite/fts-projection.ts:repairFtsProjection` and
   `src/infrastructure/sqlite/database.ts:createSqliteIndexLifecycle.openWriter`
   — run canonical validation, projection inspection, and any rebuild through
   the leased transaction primitive using the acquired index lease and injected
   clock. Remove the duplicate canonical/foreign-key validation currently run
   before `BEGIN IMMEDIATE`; retain the equivalent validation as the first body
   operation and retain the post-rebuild validation. Canonical corruption must
   still surface as `canonical-corrupt`, and projection/lease failures must roll
   back without changing canonical or FTS state. Remove/replace
   `repairFtsProjection`'s current in-body ordinary live-expiry assertions: the
   leased primitive owns entry admission/renewal and exact-owner exit
   renewal/fencing. The held immediate transaction prevents takeover during the
   synchronous body, so wall-clock expiry there requires no mid-body assertion.

3. `test/infrastructure/sqlite-writer-coordination.test.ts` — use injected clocks,
   no sleeps, and a file-backed two-handle fixture where concurrency matters.
   Prove the new primitive independently:

   - an expired exact owner with no committed takeover renews the same generation;
   - a body that advances past expiry commits its sentinel write and leaves a live
     renewed lease, while a competing handle cannot take over during the
     immediate transaction;
   - a takeover committed before the old owner enters changes generation and
     fences the old owner before mutation;
   - a thrown body after entry renewal rolls back both its sentinel write and
     renewal, after which a replacement owner can acquire the next generation;
   - backward time remains rejected without changing the lease.

4. `test/infrastructure/sqlite-fts-repair.test.ts` — prove the lifecycle uses the
   new semantics with a deterministic clock whose sequenced reads cover lease
   acquisition, leased-transaction entry, and exit and cross expiry before the
   exit renewal. Use no sleep or artificially large database. Strengthen the
   canonical-corruption case so a damaged projection remains byte/row/schema-
   equivalent and unrepaired after failure; a valid damaged projection must
   still rebuild without changing canonical rows. Keep the two-handle
   `SQLITE_BUSY` and committed-takeover proofs in the writer-coordination seam.

5. `docs/contributing/architecture.md:Durable library` and
   `docs/architecture-memo.md:Indexing and reconciliation` — document the two
   coordination scopes: lease expiry fences work between transactions; an
   already serialized immediate transaction may renew the unchanged exact owner
   at entry and exit because SQLite prevents a concurrent takeover. State that
   rollback/crash discards the transactional renewal and partial work.

## Verify

- `pnpm exec vitest run test/infrastructure/sqlite-writer-coordination.test.ts test/infrastructure/sqlite-fts-repair.test.ts test/infrastructure/sqlite-writer-cleanup.test.ts`
- `pnpm check`
- After building, run this local, uncommitted privacy wrapper against the current
  library. It captures the complete index JSON in memory, preserves a nonzero
  CLI exit, and emits only aggregate-safe evidence:

  ```bash
  node --input-type=module <<'NODE'
  import { spawnSync } from "node:child_process";
  const result = spawnSync(
    process.execPath,
    ["dist/bin/sessions.js", "index", "--source", "codex", "--format", "json"],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
  const report = JSON.parse(result.stdout);
  process.stdout.write(`${JSON.stringify({
    counts: report.counts,
    incompleteSources: report.incompleteSources,
    allCoverageComplete: report.sources.every(
      (source) => source.coverage.status === "complete",
    ),
  })}\n`);
  NODE
  ```

  Require `unchanged > 0`, `incompleteSources === 0`, and
  `allCoverageComplete === true`; the wrapper must emit no raw report, source or
  session identifiers, paths, or transcript content.

## Boundaries

- Do not lengthen the timeout, add a worker heartbeat, ignore expiry globally,
  or redesign canonical health validation.
- Apply the primitive to the proven long FTS writer-open path only; do not
  mechanically convert unrelated short repository/maintenance transactions.
- No schema migration, compatibility layer, provider write, daemon, or parallel
  indexing work.
