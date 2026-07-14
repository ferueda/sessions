# Current architecture

Status: foundation through the M2 local-state slice. This map describes code that
exists now; the [architecture memo](../architecture-memo.md) describes the
accepted target.

## Runtime flow

```text
src/bin/sessions.ts
  -> src/cli/run.ts -> src/cli/program.ts
  -> src/application/run-doctor.ts + src/application/get-paths.ts
  -> src/application/ports/index-lifecycle.ts
  -> src/infrastructure/state/{paths,index-state-diagnostic}.ts
  -> src/infrastructure/sqlite/{database,migrations,permissions}.ts
  -> src/infrastructure/{runtime,sqlite} diagnostics
```

The composition root reads the package version, resolves the platform-local index paths, wires concrete diagnostics and SQLite state inspection, and maps the returned code to `process.exitCode`. CLI presentation receives `doctor` and `paths` functions plus output writers; it does not import concrete infrastructure.

`paths` and the `index-state` doctor check receive only the inspection capability. They resolve and inspect state without creating directories, opening a writer, or applying migrations. The concrete lifecycle also implements a guarded writer for future explicit indexing, but no current public command calls it.

## Ownership

| Path                                       | Current owner                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------ |
| `src/domain/`                              | Session values, identity/hash policy, canonical validation, index-state values |
| `src/application/ports/`                   | Inward-facing source, diagnostic, and index-lifecycle contracts                |
| `src/application/source-*.ts`              | Complete input fingerprints and typed source failures                          |
| `src/application/read-session-document.ts` | Validated adapter-read boundary                                                |
| `src/application/run-doctor.ts`            | Probe aggregation and report contract                                          |
| `src/application/get-paths.ts`             | Versioned owned-state path report                                              |
| `src/infrastructure/state/`                | Platform path resolution and index-state diagnostic                            |
| `src/infrastructure/sqlite/`               | Capability probe, protected lifecycle, migrations, permissions                 |
| `src/cli/`                                 | Command grammar, rendering, stream and exit behavior                           |
| `src/bin/`                                 | Sole concrete composition root                                                 |
| `scripts/`                                 | Repository build/delivery smoke helpers; not published runtime                 |
| `test/`                                    | Cross-layer behavior and documentation contracts                               |

The shared synthetic source conformance harness and metadata-only SQLite migration exist. Canonical content tables, repository behavior, indexing/reconciliation, queries, concrete provider adapters, and packaged skills do not exist yet.

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

The internal writer uses ordered checksummed migrations, WAL, foreign keys, a five-second busy timeout, and core secure delete. Migration 1 creates only `sessions_schema_migrations`. On POSIX, the directory is constrained to `0700` and database/sidecar files to `0600`; Windows uses profile-local platform ACLs. See [privacy](../privacy.md) for guarantees and limitations.
