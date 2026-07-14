# Current architecture

Status: foundation through the M4 indexing-and-reconciliation slice. This map describes code that
exists now; the [architecture memo](../architecture-memo.md) describes the
accepted target.

## Runtime flow

```text
src/bin/sessions.ts
  -> src/cli/run.ts -> src/cli/program.ts
  -> src/application/run-doctor.ts + src/application/get-paths.ts
  -> src/application/ports/index-lifecycle.ts
  -> src/infrastructure/state/{paths,index-state-diagnostic}.ts
  -> src/infrastructure/sqlite/{database,sqlite-index-health}.ts
  -> src/infrastructure/{runtime,sqlite} diagnostics

internal M4 services (not composed into the public CLI)
  -> src/application/{run-index,discover-sessions,clear-index}.ts
  -> src/application/ports/{session-source,session-index,index-maintenance}.ts
  -> src/infrastructure/sqlite/{sqlite-session-index,index-maintenance}.ts
  -> src/infrastructure/sqlite/{writer-lease,sqlite-writer-database,migrations}.ts
```

The composition root reads the package version, resolves the platform-local index paths, wires concrete diagnostics and SQLite state inspection, and maps the returned code to `process.exitCode`. CLI presentation receives `doctor` and `paths` functions plus output writers; it does not import concrete infrastructure.

`paths` and the `index-state` doctor check receive only inspection capabilities. They resolve state without creating directories, opening a writer, or applying migrations. A ready-index doctor check uses an immutable read snapshot for bounded integrity, foreign-key, FTS, run-record, and lease-health checks. The concrete lifecycle also implements guarded reader/writer repository handles for internal indexing, but no current public command calls the writer or clear service.

## Ownership

| Path                                       | Current owner                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| `src/domain/`                              | Session values, identity/hash policy, canonical validation, index-state values    |
| `src/application/ports/`                   | Source, index, lifecycle, maintenance, health, and diagnostic contracts           |
| `src/application/source-*.ts`              | Complete input fingerprints and typed source failures                             |
| `src/application/validate-session.ts`      | Immutable candidate/source selection and canonical replacement admission          |
| `src/application/read-session-document.ts` | Validated adapter-read boundary                                                   |
| `src/application/discover-sessions.ts`     | Complete discovery admission, duplicate policy, and deterministic ordering        |
| `src/application/run-index.ts`             | Provider-neutral incremental indexing and source-scoped reconciliation            |
| `src/application/index-report.ts`          | Immutable provider-neutral aggregate/source reports                               |
| `src/application/clear-index.ts`           | Stable internal clear report                                                      |
| `src/application/run-doctor.ts`            | Probe aggregation and report contract                                             |
| `src/application/get-paths.ts`             | Versioned owned-state path report                                                 |
| `src/infrastructure/state/`                | Platform path resolution and index-state diagnostic                               |
| `src/infrastructure/sqlite/`               | Lifecycle, repository, migrations, writer lease, health, maintenance, permissions |
| `src/cli/`                                 | Command grammar, rendering, stream and exit behavior                              |
| `src/bin/`                                 | Sole concrete composition root                                                    |
| `scripts/`                                 | Repository build/delivery smoke helpers; not published runtime                    |
| `test/`                                    | Cross-layer behavior and documentation contracts                                  |

The shared source conformance harness, programmable fake indexing source, provider-neutral indexing/reconciliation service, and canonical SQLite repository exist. Query behavior, concrete provider adapters, public index/clear/query commands, and packaged skills do not exist yet.

## Dependency direction

- Domain -> domain only.
- Application -> application/domain.
- Infrastructure -> infrastructure/application/domain.
- Future adapters -> adapters/application/domain.
- CLI -> CLI/application/domain.
- Binary composition -> any production layer.

`scripts/check-dependencies.ts` enforces these boundaries for explicit relative imports and fails on an empty scan. Oxlint rejects cycles. `pnpm deps:check` is the focused gate.

## Build

Source uses explicit `.ts` imports and erasable TypeScript. `tsconfig.build.json` compiles only `src/` into `dist/`, rewrites relative extensions to `.js`, and emits source maps. The package exposes no library API; published consumers execute `dist/bin/sessions.js`.

## State

The owned directory is the platform cache leaf `sessions`, or the exact absolute `SESSIONS_CACHE_DIR` override. It contains `index.sqlite3` and any SQLite WAL/SHM sidecars. `sessions paths` reports these locations and initialization state without creating them; doctor also inspects without mutation.

The internal writer uses ordered checksummed migrations, WAL, foreign keys, a five-second busy timeout, core secure delete, and per-table FTS secure delete when supported. Migration 1 bootstraps history; migration 2 adds provider-neutral session tracking, canonical documents, bounded run diagnostics, collision-safe content values/occurrences, and derived external-content FTS; migration 3 adds a singleton generation lease for `index` and `clear` ownership.

One renewable lease owner may write at a time. Every repository mutation verifies its token, generation, purpose, and expiry in the same transaction. Expired takeover fences stale writers and marks abandoned active runs interrupted before new work. A writer may open valid WAL recovery state; immutable readers and doctor still refuse recovery sidecars. Repository replacement remains atomic and preserves last-good content after refresh failure.

Internal clear maintenance never opens provider paths or recursively deletes the cache directory. It removes only the known database/WAL/SHM files after path-safety checks and, for a current schema, a fenced checkpoint. Snapshot-scoped readers and ready-index health inspection do not create files, sidecars, migrations, or other mutations. On POSIX, the directory is constrained to `0700` and database/sidecar files to `0600`; Windows uses profile-local platform ACLs. See [privacy](../privacy.md) for guarantees and limitations.

These are current M4 mechanics, not the accepted public retention lifecycle.
[ADR 0007](../decisions/0007-retain-a-durable-canonical-library.md) requires M5
to move canonical data to platform application data, retain the latest successful
snapshot after complete-scan absence, separate source presence from freshness,
expose only explicit forget/data-clear deletion, arbitrate schema-3 ownership in
the same transaction as migration, and remove valid schema 3 from the
non-current direct-unlink clear path. It also adds an exact application-data
`.scratch` path behind a writer-leased provider-neutral private-directory
capability; adapters never receive `IndexPaths`, and only explicit data clear
recursively removes that validated subtree. This current-code map should be
rewritten after that implementation lands.
