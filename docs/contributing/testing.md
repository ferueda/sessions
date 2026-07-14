# Testing

Tests prove contracts at the highest stable seam that can observe them. They are deterministic and offline unless a command is explicitly a dependency/release operation.

## Layers

| Layer                   | Proves                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| Domain/application unit | Canonical rules, probe aggregation, indexing/reconciliation decisions                        |
| Provider golden fixture | Faithful parsing and malformed-format behavior                                               |
| Adapter conformance     | Shared `probe`/`discover`/`read` contract and read-only operation                            |
| SQLite integration      | Migrations, transactions, FTS behavior, permissions, last-good state                         |
| Query corpus/contract   | Literal FTS, filters, rank/ties, cursors, context, lineage, and support units                |
| CLI contract            | Arguments, streams, exit codes, human/structured schemas, bounded output                     |
| Dist smoke              | Compiled JavaScript entrypoint works                                                         |
| Package smoke           | Allowlisted tarball installs offline from the populated pnpm store and generated binary runs |
| Docs contract           | Required routes exist and no contributor-machine paths drift in                              |

Canonical domain/application contracts, synthetic adapter conformance,
programmable fake-source indexing, fresh-baseline bootstrap, obsolete-development-
schema rejection, current writer fencing, real-SQLite non-destructive
reconciliation, forget/all-data maintenance, immutable library health, and the
complete current CLI contract run today. The Codex proof uses
generated current/base/optional state schemas plus plain/Zstandard rollouts and
active-WAL capture stress; it never reads developer history. M6 query proofs use
a checked-in generic corpus and temporary SQLite libraries. Export and Cursor
contracts arrive with their milestones.

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
- Use synthetic provider data and temporary provider/application-data paths.
- Never call provider services or the network in unit/integration tests.
- Test an operational failure as well as success when adding a state boundary.
- Fully exhaust discovery before mutation; prove incomplete scans cannot reconcile deletions.
- For M5 and later, prove complete scans mark unseen retained sessions missing
  without deleting canonical rows, while unavailable or incomplete scans prove no
  absence. Projection rebuilds preserve canonical rows; only explicit
  forget/data-clear cases exercise transcript deletion.
- Use injected clocks and fake schedulers for lease/heartbeat tests; do not sleep.
- After compatibility begins with the first published release, any migration that
  changes lease semantics must prove old-schema ownership is arbitrated and fenced
  before table changes. Pre-alpha baseline changes instead reject obsolete
  development databases without mutation.
- Prove inspection commands preserve database bytes, timestamps, run rows, directory entries, and absent state.
- Prove fresh-library list returns an empty success without opening a reader,
  creating state, or resolving a provider.
- Exercise writer behavior only through the coordinated lifecycle; do not construct an unguarded production writer.
- For an adapter using a frozen discovery generation, distinguish snapshot-owned
  inputs from live read inputs in conformance fixtures. Prove lease-scoped
  workspace cleanup/error aggregation and fail the Codex milestone unless
  concurrent writer/checkpoint/WAL-reset stress always captures one complete
  committed generation without provider mutation.
- Keep hooks cheap; passing a hook is not repository approval.
