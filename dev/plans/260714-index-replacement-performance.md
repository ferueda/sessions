# Eliminate whole-library cleanup from session replacement

## Goal

The M6 live dogfood run exposed a confirmed indexing hot path: every changed
session ends `replaceCanonicalDocument` with a whole-library scan of
`sessions_content_values`. On a library with roughly 1.4k sessions and 347k
distinct text values, a warm equivalent scan took about 0.46 seconds; repeating
it for roughly 1.4k replacements directionally explains most of the observed
15–16 minute V3 refresh, while a stable unchanged run completed in under a
minute.

Make replacement cleanup proportional to the distinct content formerly owned
by the replaced session, not the complete library. A successful replacement
must still immediately remove its obsolete unshared text, retain shared or
reintroduced text, keep FTS synchronized, and preserve the existing atomic
last-good rollback behavior. No public contract or on-disk schema changes.

## Changes

1. `src/infrastructure/sqlite/sqlite-session-document.ts:replaceCanonicalDocument`
   — before deleting the old canonical row, capture its distinct non-null
   `content_id` values. After inserting the new document, reuse one guarded
   delete statement for those candidates and delete only values that still have
   no occurrence. Keep capture, cascade deletion, insertion, and cleanup inside
   the existing `replaceSession` immediate transaction so failure rolls back the
   document, content, FTS triggers, and cleanup together. Remove the per-session
   whole-library `garbageCollectContent` path; unrelated orphan repair is no
   longer an incidental replacement responsibility.
2. `src/infrastructure/sqlite/sqlite-session-document.ts:insertEntries` and
   `internContent` — prepare the content-value insert and lookup statements once
   per replacement and thread them through the existing insertion helpers. Keep
   statements scoped to that database/replacement; do not add module-global
   caches, asynchronous work, batching, or a second persistence abstraction.
3. `test/infrastructure/sqlite-session-index.test.ts` — extend the real
   `DatabaseSync` integration seam with a deterministic locality regression:
   seed target-only, shared, reintroduced, and unrelated orphan content; replace
   the target session; prove only obsolete target candidates disappear, shared
   and reintroduced values remain, the unrelated sentinel is not swept, and FTS
   integrity/search visibility stays exact. Strengthen the forced-failure case
   to prove the former document/content/FTS state survives rollback. Follow the
   Vitest isolation guidance and assert database outcomes rather than mocks or
   wall-clock thresholds.
4. `docs/contributing/architecture.md:Durable library` — record that canonical
   replacement prunes only its former unreferenced content inside the same
   transaction. Name whole-library orphan repair as a separate maintenance
   concern if a legitimate producer is ever found; it must not return to the
   per-session changed path.
5. `dev/plans/README.md` and this plan — while active, place this hardening gate
   before M7. After implementation and verification, remove this completed plan
   and restore M7 as the next roadmap work; Git history remains the archive.

## Verify

- `pnpm exec vitest run test/infrastructure/sqlite-session-index.test.ts`
- `pnpm check`
- Build the public CLI, then run privacy-safe aggregate-only cold and stable
  indexes with a fresh temporary `SESSIONS_DATA_DIR` against read-only real Codex
  data. Record external elapsed time and aggregate index counts, and prove the
  provider tree is unchanged. Treat timing as comparative diagnostic evidence,
  not a flaky CI threshold.

## Boundaries

- No public phase timings, progress events, telemetry, `IndexReport` fields, or
  observer port. Reassess instrumentation only after the scoped fix reveals the
  residual cost.
- Do not change writer-open canonical/foreign-key/FTS validation, FTS repair,
  adapters or rollout parsing, application/domain ports, document digests, query
  behavior, migrations, concurrency, or transaction ownership.
- Do not preserve the global scan as a fallback. If inspection finds a normal
  successful transaction that can create unrelated content orphans, stop and
  design one explicit writer-maintenance operation instead of hiding it in every
  session replacement.
- No performance assertions based on elapsed wall time in the automated suite.
