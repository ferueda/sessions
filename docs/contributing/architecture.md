# Current architecture

Status: foundation through the M3 canonical-repository slice. This map describes code that
exists now; the [architecture memo](../architecture-memo.md) describes the
accepted target.

## Runtime flow

```text
src/bin/sessions.ts
  -> src/cli/run.ts -> src/cli/program.ts
  -> src/application/run-doctor.ts + src/application/get-paths.ts
  -> src/application/ports/{index-lifecycle,session-index}.ts
  -> src/infrastructure/state/{paths,index-state-diagnostic}.ts
  -> src/infrastructure/sqlite/{database,migrations,permissions,sqlite-session-index}.ts
  -> src/infrastructure/{runtime,sqlite} diagnostics
```

The composition root reads the package version, resolves the platform-local index paths, wires concrete diagnostics and SQLite state inspection, and maps the returned code to `process.exitCode`. CLI presentation receives `doctor` and `paths` functions plus output writers; it does not import concrete infrastructure.

`paths` and the `index-state` doctor check receive only the inspection capability. They resolve and inspect state without creating directories, opening a writer, or applying migrations. The concrete lifecycle also implements guarded reader/writer repository handles for future explicit indexing and query commands, but no current public command calls them.

## Ownership

| Path                                       | Current owner                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `src/domain/`                              | Session values, identity/hash policy, canonical validation, index-state values       |
| `src/application/ports/`                   | Inward-facing source, diagnostic, and index-lifecycle contracts                      |
| `src/application/source-*.ts`              | Complete input fingerprints and typed source failures                                |
| `src/application/validate-session.ts`      | Immutable observation and canonical replacement admission                            |
| `src/application/read-session-document.ts` | Validated adapter-read boundary                                                      |
| `src/application/run-doctor.ts`            | Probe aggregation and report contract                                                |
| `src/application/get-paths.ts`             | Versioned owned-state path report                                                    |
| `src/infrastructure/state/`                | Platform path resolution and index-state diagnostic                                  |
| `src/infrastructure/sqlite/`               | Capability probe, protected lifecycle, canonical repository, migrations, permissions |
| `src/cli/`                                 | Command grammar, rendering, stream and exit behavior                                 |
| `src/bin/`                                 | Sole concrete composition root                                                       |
| `scripts/`                                 | Repository build/delivery smoke helpers; not published runtime                       |
| `test/`                                    | Cross-layer behavior and documentation contracts                                     |

The shared synthetic source conformance harness and canonical SQLite repository exist. Indexing/reconciliation, query behavior, concrete provider adapters, and packaged skills do not exist yet.

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

The internal writer uses ordered checksummed migrations, WAL, foreign keys, a five-second busy timeout, core secure delete, and per-table FTS secure delete when supported. Migration 1 bootstraps history; migration 2 adds provider-neutral session tracking, canonical documents, bounded run diagnostics, collision-safe content values/occurrences, and derived external-content FTS. Repository replacement is atomic and preserves last-good content after refresh failure. Snapshot-scoped readers open the ready index without creating files or sidecars. On POSIX, the directory is constrained to `0700` and database/sidecar files to `0600`; Windows uses profile-local platform ACLs. See [privacy](../privacy.md) for guarantees and limitations.
