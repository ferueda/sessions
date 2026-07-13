# Initial repository scaffold

## Goal

Create an honest, installable pre-alpha foundation for the standalone Sessions CLI. Preserve the approved architecture and product intent in durable docs, enforce the first dependency boundaries in code, and provide one complete local verification command.

Harness source baseline: `ferueda/harness@fead436b9c810c3f0a3952789f0716765ddbc8f9`.

## Authority

- Accepted product intent: `docs/project-intent.md`
- Accepted target design and roadmap: `docs/architecture-memo.md`
- Original request: preserve the agreed standalone direction, scaffold this repository, and add codebase-owned guardrails without changing the existing Harness implementation.

## Boundaries

- Include help, version, and a real runtime/SQLite FTS5 `doctor` command.
- Define the provider-neutral session model and source-adapter input port, but keep them internal and pre-1.0.
- Do not add placeholder index, list, search, show, or export commands.
- Do not copy Harness analysis, evidence, automation filtering, cache, or provider orchestration code.
- Do not publish a nonfunctional Agent Skill. Preserve its use cases and planned layout; create it with the skill scaffold once search/show/export exist.
- Defer adapters, index schema/migrations, query ranking, release automation, and Harness synchronization to later vertical slices.

## Changes

### 1. Durable project context

- Add a short root `AGENTS.md`, public `README.md`, `CONTRIBUTING.md`, and `SECURITY.md`.
- Record normative intent in `docs/project-intent.md` and the approved target design in `docs/architecture-memo.md`.
- Add privacy and CLI contracts that distinguish current behavior from planned behavior.
- Add contributor maps for current architecture, setup, commands, adapter contract, and testing.
- Add concise ADRs for the canonical index, adapter isolation, provenance semantics, compiled delivery, and one-way Harness ownership.

### 2. Executable CLI foundation

- Add strict ESM TypeScript configuration targeting compiled Node.js output.
- Add canonical session types and an open `SessionSource` port with `probe`, `discover`, and `read` responsibilities.
- Add an application-level diagnostic runner and concrete Node/SQLite FTS5 probes.
- Add the CLI presentation layer and composition root. Map success to exit `0`, operational failure to `1`, and usage failure to `2`; keep data on stdout and diagnostics on stderr.
- Use the Node guidance for erasable TypeScript, explicit `.ts` source imports, and rewritten `.js` build imports.

Initial module map:

| Path                                             | Owner                                                                             |
| ------------------------------------------------ | --------------------------------------------------------------------------------- |
| `src/domain/session.ts`                          | Provider-neutral identity, session, entry, content, provenance, and lineage types |
| `src/application/ports/session-source.ts`        | Open source-adapter input port and discovery/read values                          |
| `src/application/ports/runtime-diagnostic.ts`    | Diagnostic port and result contract                                               |
| `src/application/run-doctor.ts`                  | Probe aggregation and doctor report                                               |
| `src/infrastructure/runtime/node-diagnostic.ts`  | Minimum Node runtime probe                                                        |
| `src/infrastructure/sqlite/sqlite-diagnostic.ts` | In-memory SQLite/FTS5 capability probe                                            |
| `src/cli/program.ts`                             | Commander grammar and human/JSON rendering                                        |
| `src/cli/run.ts`                                 | Parse and exit-code boundary                                                      |
| `src/bin/sessions.ts`                            | Sole composition root and package binary entrypoint                               |
| `scripts/check-dependencies.ts`                  | Enforced production import graph                                                  |
| `tsconfig.json`, `tsconfig.build.json`           | Direct-source checks and distributable build                                      |

Allowed production dependencies:

- `domain` -> `domain` only.
- `application` -> `application` and `domain`.
- `infrastructure` -> `infrastructure`, `application`, and `domain`; never adapters or CLI.
- Future `adapters` -> `adapters`, `application`, and `domain`; never infrastructure or CLI.
- `cli` -> `cli`, `application`, and `domain`; never concrete adapters or infrastructure.
- `bin` is the sole exception and may import every production layer to compose concrete implementations.
- No production cycles. Tests and repository scripts are outside this production graph.

Implementation note: dependency-cruiser 18 cannot inspect TypeScript 7.0 and yielded a vacuous zero-module pass. The repository-owned checker scans explicit static/dynamic relative imports, fails when it finds no production modules, and is covered by `test/architecture.test.ts`.

The build compiles `src/` to `dist/` with `src/` as `rootDir`; `package.json` maps `sessions` to `dist/bin/sessions.js`.

Doctor contract:

- Human: `sessions doctor`. JSON: `sessions doctor --format json`.
- JSON shape: `{ schemaVersion: 1, command: "doctor", ok, checks }`. Every check has stable `id`, `label`, `ok`, `summary`, and string-valued `details`.
- Checks run in declared order and all run even after a failure. A thrown probe error becomes a sanitized failed check so later probes still run.
- All checks passing writes the complete report to stdout, leaves stderr empty, and exits `0`.
- One or more failed checks still writes the complete report to stdout, leaves stderr empty, and exits `1`; the report itself is requested diagnostic data.
- An unexpected failure outside probe aggregation writes one concise diagnostic to stderr, emits no fabricated report, and exits `1`.
- Invalid CLI usage writes to stderr and exits `2`.
- The scaffold checks `node-runtime` and `sqlite-fts5`. SQLite uses `:memory:` and doctor performs no source discovery, indexing, or persistent writes.

### 3. Repository guardrails

- Add formatting, linting, dependency-boundary, typecheck, Vitest, build, dist smoke, and packed-install smoke gates.
- Add focused CLI, diagnostic, SQLite, architecture-boundary, and docs-contract tests. Follow the Vitest guidance for isolated state, awaited async behavior, and specific assertions.
- Cover doctor all-pass, failed-check, thrown-probe aggregation, JSON schema version, stream placement, exit mapping, and absence of persistent index state at the CLI seam.
- Add a cheap staged-files pre-commit hook plus full typecheck. Keep the full gate explicit.
- Expose `pnpm check` as the single definition of done and `pnpm check:ci` as its CI alias.

### 4. Hosted automation

- Add least-privilege CI on Linux, macOS, and Windows using the same full gate.
- Add weekly grouped Dependabot updates for npm and GitHub Actions.
- Document release-please plus npm trusted publishing/provenance as a pre-release step; do not add a publish workflow before package ownership and the GitHub environment are configured.

## Verify

- `pnpm check`
- Confirm the packed tarball installs in an isolated temporary project and its generated `sessions` executable runs help, version, and doctor.
- Confirm durable docs contain no contributor-machine absolute paths and all required project routes exist.
- Run the repository plan reviewer before implementation and the change-review workflow after implementation.
