# Add atomic revision manifests

## Goal

Add `sessions manifest` as the first post-V1 evidence contract. A successful
call returns one complete, transcript-free inventory of the matching retained
session revisions from one immutable library snapshot. It must let a consumer
retain the exact cohort in its own authorized context, compare canonical
identity plus document digest, and later hydrate only changed revisions without
paging across writer generations.

The command accepts the existing session-level filters except raw `workspace`,
requires `--format json|jsonl`, and has no human format, cursor, or truncating
limit. Results use binary source-kind, source-instance, and native-ID order.
Success is complete through 10,000 revisions; a larger cohort or an encoded
result over 16 MiB fails before stdout and tells the caller to narrow the
selection. Empty and uninitialized libraries succeed. The command does not
resolve providers, read transcript bodies, expose paths or internal generation
state, retain old revisions, or make a later export atomic with the manifest.

A privacy-safe local measurement found that deriving grouped logical text bytes
from a multi-gigabyte library takes about 12 seconds. Store exact canonical
document metrics during capture and backfill them once in index schema 2 so the
normal manifest query remains metadata-sized. Structured output remains schema
1; the SQLite schema version and public output schema are separate contracts.

## Public contract

```text
sessions manifest
  [--source KIND [--instance INSTANCE]] [--native-id ID]
  [--source-state present|missing|unknown]
  [--activity-after TIME] [--activity-before TIME]
  [--captured-after TIME] [--captured-before TIME]
  [--observed-after TIME] [--observed-before TIME]
  [--session CANONICAL-ID]
  --format json|jsonl
```

The JSON bundle has `schemaVersion: 1`, `command: "manifest"`,
`type: "manifest"`, `disposition: "untrusted-history"`, `revisionCount`, one
`selection`, one `captureScope`, and ordered `revisions`. JSONL emits the same
manifest envelope first, followed by one `type: "revision"` record per item in
the same order. Every revision contains only:

- `session` and `documentDigest`;
- optional `createdAt` / `updatedAt`, plus `capturedAt`, `sourceObservedAt`,
  `sourceState`, `freshness`, and `adapterVersion`;
- `lineageCoverage` and the query-derived known/unknown `root`; and
- `counts` with exact `relations`, `entries`, `segments`, `omittedSegments`,
  and logical `textUtf8Bytes`. Text bytes count every canonical text-segment
  occurrence and exclude title text.

`selection` contains `order: "canonical-identity-v1"`,
`maximumRevisions: 10000`, and the normalized active filter values. A
`--session` value uses the public session-ref shape. It never contains
workspace, paths, cursors, a library/writer generation, or a private filter
fingerprint. There is no aggregate manifest digest in this slice: the exact
ordered artifact and each session identity plus document digest are the
verification boundary.

## Changes

1. `src/domain/session-document-metrics.ts` and
   `src/domain/session-manifest.ts` — add immutable value types and creators for
   exact document metrics, the workspace-free manifest filter/query, selection,
   revision item, and result. Define
   `MAX_SESSION_MANIFEST_REVISIONS = 10_000`; reject a runtime `workspace` field
   and invalid shared filters before library inspection. Metric creation must
   use safe integers, count segment occurrences rather than deduplicated content
   rows, and compute raw UTF-8 bytes without including title text. Cover
   admission, copying/freezing, Unicode bytes, repeated content, omissions, and
   unsafe totals in focused domain tests.

2. `src/infrastructure/sqlite/migrations/0002-session-document-metrics.ts`,
   `src/infrastructure/sqlite/migrations.ts`, and
   `test/infrastructure/sqlite-canonical-migration.test.ts` — advance the index
   to schema 2 with a strict `sessions_canonical_document_metrics` table keyed
   one-to-one to `sessions_canonical_sessions`. Backfill relation, entry,
   segment, omitted-segment, and logical text-byte totals with set-based SQL in
   the migration transaction. Prove a seeded schema-1 library migrates without
   changing canonical documents or document digests, receives exact occurrence
   counts for every canonical row, rolls back a failed backfill, and remains
   data-clear/forget/compact compatible through the existing foreign-key
   lifecycle. The foreign key prevents orphan metrics but does not prove the
   inverse; reads and health checks below must fail closed when a canonical row
   lacks metrics.

3. `src/infrastructure/sqlite/sqlite-session-document.ts` and
   `src/infrastructure/sqlite/sqlite-index-health.ts` — compute metrics from
   each admitted canonical document and insert them in the same replacement
   transaction as its document rows. When a complete document is read,
   recompute and compare its stored metrics alongside the existing digest proof
   so a missing or inconsistent derivative is canonical corruption, not
   plausible manifest data. Extend canonical health to require exactly one
   metrics row per retained canonical session and verify the derivative during
   its existing semantic document pass. Extend the SQLite session-index and
   health contracts to prove replacement updates metrics atomically, rollback
   preserves the prior document/digest/metrics, and missing or changed metrics
   fail health.

4. `src/application/ports/session-query.ts`,
   `src/infrastructure/sqlite/database.ts`,
   `src/infrastructure/sqlite/sqlite-session-query.ts`, and new
   `src/infrastructure/sqlite/sqlite-session-manifest.ts` — add one repository
   `manifest(query)` operation and wrap the whole operation in one existing
   `SqliteReadSnapshot.run`. Inside that call, read capture scope, bounded cohort
   rows, stored metrics, and whole-library lineage evidence from the same
   connection. First select and bound at most 10,001 canonical identities
   independently of metrics presence. Then use a canonical-first set-based
   cohort query with a left join to metrics, the existing safe filter SQL, and
   one retained-root resolver; fail the whole operation as canonical corruption
   if any selected revision lacks its metrics row. Do not adapt page-sized
   `list()` hydration or add per-session summary/count queries. Order by the
   three identity components with binary collation. Fail the whole call with a
   sanitized operational error when the canonical cohort cap is exceeded.
   Validate every stored enum, timestamp, digest, metric, and safe integer before
   returning.

   Extend `test/contracts/session-query.contract.ts` and its SQLite fixture with
   one coherent filter/capture-scope case, present/missing/unknown revisions,
   exact metrics and lineage, contradictory and case-sensitive filters,
   repeated-call equality, and binary identity order. Add a generated
   201-session case to prove the result crosses the old list-page boundary
   without a cursor. Add
   `test/infrastructure/sqlite-session-manifest-limit.test.ts` with generated
   metadata-only canonical/tracking/metrics rows to prove the repository returns
   exactly 10,000 ordered revisions and rejects 10,001 matching revisions with
   the sanitized whole-call error; do not spend this boundary proof indexing
   10,001 transcript fixtures. In the normal repository contract, delete one
   selected metrics row and prove manifest fails rather than omitting that
   canonical revision or returning a partial result. Keep concurrent-change
   proof at
   `test/infrastructure/sqlite-reader-lifecycle.test.ts`: add manifest coverage
   only to show that the repository result is discarded as one unit, reusing
   the existing snapshot mutation seam rather than timing a real writer.

5. `src/application/create-session-manifest.ts` — admit the query before
   inspection, return the exact empty selection plus uninitialized capture scope
   without opening storage, and otherwise make exactly one reader repository
   call. Select and deeply copy only the public manifest fields. Add an
   application workflow test for ready/uninitialized/unavailable state, reader
   closure and combined failures, immutable output, exact selection echo, and
   the absence of document/transcript or provider calls.

6. `src/cli/program.ts`, `src/cli/structured-output.ts`,
   `src/cli/structured-output-encoding.ts`, and `src/bin/sessions.ts` — add the
   mandatory machine-format command without `--workspace`, `--limit`, or
   `--cursor`; compose it only from the lifecycle and resolved Sessions paths.
   Add closed JSON/JSONL DTOs and builders for the exact contract above. Build,
   validate, and encode every record before the first write, retaining the 16
   MiB boundary and updating its narrowing advice to include manifest. Extend
   `test/cli.test.ts` and `test/cli-structured-output.test.ts` with grammar and
   forwarding, exact nonempty/empty shapes, JSON/JSONL evidence equivalence and
   order, recursive allowlisting of private/content fields, invalid values, the
   exact-size boundary, and zero stdout on cohort/encoding failure.

7. `test/list-no-provider-resolution.test.ts` and
   `scripts/smoke-workflow.ts` — prove the production manifest path does not
   construct a provider and add one representative structured manifest to the
   shared dist/package journey. Keep the edge matrix in the focused tests.

8. `scripts/measure-manifest.ts`, `package.json`, and
   `docs/contributing/testing.md` — add an opt-in, provider-free
   `pnpm measure:manifest` run over roughly 2,000 generic sessions. Assert the
   full cohort, exact repeated equality, order, counts, and encoded size, then
   report elapsed time without a timed CI threshold. The script stays outside
   `pnpm check` and guards against accepting an N+1 or transcript-scanning
   implementation.

9. `docs/project-intent.md`, `docs/architecture-memo.md`,
   `docs/privacy.md`, `docs/reference/cli-contract.md`,
   `docs/reference/structured-output.md`,
   `docs/contributing/architecture.md`, `docs/contributing/commands.md`,
   `README.md`, and the relevant getting-started page — document manifest as
   current post-V1 behavior and leave digest-guarded coordinate reads as the next
   planned milestone. Specify the schema-2 migration, complete-or-error bounds,
   selection-value allowlist, stored-metric semantics, output DTOs, and lack of
   pinning. Keep V1 acceptance historical and distinguish stored digests/metrics
   from fresh whole-library semantic validation.

10. `skills/sessions/references/evidence-protocol.md`, every skill route that
    adopts manifests, and the existing skill contract tests — for work that
    needs a fixed multi-session cohort, route the packaged skill through
    manifest and keep the exact artifact only in the active analysis context or
    evidence ledger by default. A durable local artifact is allowed only when
    the user explicitly requests it and supplies or approves an in-scope
    destination; manifest use never authorizes automatic project, skill, or
    library writes. Accept a later export only when both canonical identity and
    document digest match its revision. On a mismatch, retry the manifest or
    re-key the work; never claim the older body is retained. Do not turn
    manifest into a relevance, meaning, outcome, or recommendation layer.

## Verify

- `pnpm test test/domain/session-manifest.test.ts test/infrastructure/sqlite-canonical-migration.test.ts test/infrastructure/sqlite-session-query.contract.test.ts test/infrastructure/sqlite-session-manifest-limit.test.ts test/application/create-session-manifest.test.ts test/cli-structured-output.test.ts test/cli.test.ts`
- `pnpm measure:manifest`
- `pnpm check`

## Boundaries

- Do not add coordinate/range reads, historical pinning, archive/import,
  capability negotiation, schema selection flags, stable machine error codes,
  streaming, workspace references, local project facets, or a manifest-level
  digest.
- Do not expose title, transcript/excerpts, workspace, paths, locators, source
  metadata, provider roots, attachment references, content hashes, relation
  graphs, library identity, writer generation, lease state, or fingerprints.
- Do not truncate or page a successful cohort. If 10,000 revisions or 16 MiB is
  insufficient, fail before stdout and require explicit safe filters.
- Do not make the CLI or Agent Skill persist a manifest automatically. Normal
  command output remains stdout and normal skill use remains read-only; a
  durable artifact requires the user's explicit request and an in-scope
  destination.
- STOP if the implemented normal query touches `sessions_content_values.text`,
  reconstructs a canonical document, resolves a provider, performs N+1 cohort
  reads, or cannot keep capture scope, revisions, metrics, and roots inside one
  verified snapshot.
