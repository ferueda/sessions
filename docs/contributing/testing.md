# Testing

Tests prove contracts at the highest stable seam that can observe them. They are deterministic and offline unless a command is explicitly a dependency/release operation.

## Layers

| Layer                   | Proves                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| Domain/application unit | Canonical rules, probe aggregation, indexing/reconciliation decisions                        |
| Provider golden fixture | Faithful parsing and malformed-format behavior                                               |
| Adapter conformance     | Shared `probe`/`discover`/`read` contract and read-only operation                            |
| SQLite integration      | Migrations, transactions, FTS behavior, permissions, last-good state                         |
| CLI contract            | Arguments, streams, exit codes, human/structured schemas, bounded output                     |
| Dist smoke              | Compiled JavaScript entrypoint works                                                         |
| Package smoke           | Allowlisted tarball installs offline from the populated pnpm store and generated binary runs |
| Docs contract           | Required routes exist and no contributor-machine paths drift in                              |

Canonical domain/application contracts, the synthetic adapter conformance suite,
programmable fake-source indexing, real-SQLite reconciliation, schema-v3 writer
coordination and recovery, clear maintenance, immutable ready-index health,
path/state behavior, canonical repository integration, and `doctor`/`paths` CLI
contracts run today. Provider golden fixtures and query contracts arrive with
their corresponding vertical slices.

## Commands

```bash
pnpm test
pnpm test:docs
pnpm test:watch
pnpm typecheck
pnpm deps:check
pnpm smoke:dist
pnpm smoke:package
pnpm check
pnpm check:docs
```

`pnpm check` is the definition of done: format, lint, dependency graph, types, tests, build, dist smoke, then packed-install smoke. CI invokes the same gate.

CI classifies the complete pull-request or push diff. A diff containing only
Markdown files runs `pnpm check:docs` on Ubuntu; the required macOS and Windows
check contexts complete without dependency setup or tests. Any non-Markdown path
runs the full gate on all three operating systems. `pnpm check:docs` is a CI
optimization, not a substitute for `pnpm check` before merging implementation.

## Test rules

- Isolate mutable state and clean temporary directories.
- Await asynchronous work and assertions.
- Prefer specific behavioral assertions over broad snapshots.
- Use synthetic provider data and temporary home/cache paths.
- Never call provider services or the network in unit/integration tests.
- Test an operational failure as well as success when adding a state boundary.
- Fully exhaust discovery before mutation; prove incomplete scans cannot reconcile deletions.
- Use injected clocks and fake schedulers for lease/heartbeat tests; do not sleep.
- Prove inspection commands preserve database bytes, timestamps, run rows, directory entries, and absent state.
- Exercise writer behavior only through the coordinated lifecycle; do not construct an unguarded production writer.
- Keep hooks cheap; passing a hook is not repository approval.
