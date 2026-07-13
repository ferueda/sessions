# Current architecture

Status: foundation scaffold. This map describes code that exists now; the [architecture memo](../architecture-memo.md) describes the accepted target.

## Runtime flow

```text
src/bin/sessions.ts
  -> src/cli/run.ts -> src/cli/program.ts
  -> src/application/run-doctor.ts
  -> src/infrastructure/runtime/node-diagnostic.ts
  -> src/infrastructure/sqlite/sqlite-diagnostic.ts
```

The composition root reads the package version, wires concrete diagnostics, and maps the returned code to `process.exitCode`. CLI presentation receives the doctor function and output writers; it does not import concrete infrastructure.

## Ownership

| Path                            | Current owner                                                  |
| ------------------------------- | -------------------------------------------------------------- |
| `src/domain/`                   | Provider-neutral session values                                |
| `src/application/ports/`        | Inward-facing source and diagnostic contracts                  |
| `src/application/run-doctor.ts` | Probe aggregation and report contract                          |
| `src/infrastructure/`           | Concrete runtime capability checks                             |
| `src/cli/`                      | Command grammar, rendering, stream and exit behavior           |
| `src/bin/`                      | Sole concrete composition root                                 |
| `scripts/`                      | Repository build/delivery smoke helpers; not published runtime |
| `test/`                         | Cross-layer behavior and documentation contracts               |

Indexing, storage, query, provider adapters, and packaged skills do not exist yet.

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

The current runtime creates no persistent Sessions state. Planned index ownership and permissions are specified in [privacy](../privacy.md), not implemented here.
