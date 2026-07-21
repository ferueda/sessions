# Testing

## Purpose

Tests are part of the Sessions engineering harness. They keep canonical data,
read-only provider boundaries, local persistence, CLI behavior, and package
delivery visible while humans and agents change the repository.

The goal is high-confidence feedback at the cheapest stable boundary, not maximum
test count. This is the canonical testing strategy; other contributor docs should
link here. [`package.json`](../../package.json) owns executable commands, and
[commands](commands.md) documents their effects.

## Principles

- Encode durable intent: stable outcomes, contracts, and forbidden side effects,
  not private call order, broad snapshots, incidental formatting, or prose.
- Prefer a small, high-signal suite. Every slower test must justify its cost.
- Choose the narrowest stable seam that proves the behavior. Add another layer
  only for a materially different failure mode.
- Keep related assertions in a coherent workflow-shaped test: set up the world,
  act, then assert important intermediate and final outcomes.
- Prefer explicit local setup and ready-to-run factories. Avoid hidden fixtures,
  order dependencies, and shared mutable state.
- Do not test guarantees already enforced by strict TypeScript.
- Keep routine proof deterministic and offline. Never depend on contributor
  provider/library state, external credentials, public networks, or sleeps.
- At state boundaries, cover meaningful failure: incomplete discovery cannot
  infer absence, missing sources retain canonical rows, inspection stays
  non-mutating, and writers use the coordinated lifecycle.
- Add regression coverage when a stable seam protects a realistic repeat
  failure; do not manufacture brittle proof for a one-off symptom.
- Keep a high bar for SQLite integration, subprocess, smoke, E2E, and live tests.

## Layers

All current Vitest suites live under `test/`; `vitest.config.ts` also permits
`src/**/*.test.ts`. Smokes live in `scripts/`, outside default discovery.

| Layer                 | Current placement                                                                | Proves                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Domain/module         | `test/domain/**`, focused pure application tests                                 | Canonical validation, public projection/JCS digests, query values, identity, parsing, bounds                     |
| Application workflow  | `test/application/**` with injected ports/fakes and the shared provider workflow | Discovery, index/reconciliation, retention, list/search/entries/show/export/forget/repair, selection, failures   |
| Adapter/conformance   | `test/adapters/{cursor,codex}/**`, source contracts/fixtures                     | `probe`/`discover`/`read`, replacement guards, fingerprints, normalization, safe failures, provider non-mutation |
| SQLite/filesystem     | `test/infrastructure/**`, application `*.sqlite.test.ts`                         | Migrations, document digests, FTS5, transactions, permissions, leases, WAL, cleanup, retained rows               |
| Query corpus/contract | `test/fixtures/session-query-corpus.ts`, query contracts and SQLite query tests  | Literal FTS, textless entries, filters, rank/ties, cursors, context, lineage, support units                      |
| CLI/process           | `test/cli*.test.ts`, focused root process tests                                  | Grammar, exact JSON/JSONL DTOs, rendering; composition, streams, exits, and side effects                         |
| Repository contract   | `test/{architecture,ci-change-scope,docs-contracts}.test.ts`                     | Dependency direction, CI classification, docs routes/links, private-path exclusion                               |
| Agent Skill contract  | `test/skill-contracts.test.ts`, evaluator-owned forward cases                    | Exact layout/metadata/routes, shared evidence rules, shipped CLI use, safety limits, and seven prompt rubrics    |
| Distribution smoke    | `scripts/smoke-dist.ts` plus the shared workflow                                 | Compiled binary plus synthetic indexing/query/entries/show/export, orphan repair, compaction, deletion           |
| Package smoke         | `scripts/smoke-package.ts` plus the shared workflow                              | Offline-installed CLI journey plus the exact independent ten-file skill tree and resolvable references           |
| Release qualification | One hashed tarball plus Linux/macOS/Windows release smokes                       | Normal global npm install, shim, pinned `npx`, skill, metadata, and the shared synthetic workflow                |
| Agent forward eval    | Fresh agents over an isolated generic retained corpus                            | Route choice, facts-first evidence, provenance, privacy, bounded output, honest unknowns, and no auto-mutation   |

There is no separate E2E framework, system-smoke lane, networked provider test,
or authenticated live command today. JSON/JSONL delivery, Cursor/Codex indexing,
export, and the packaged Agent Skill are current coverage.

## Choosing proof

| Change                                    | Preferred proof                                                            | Focused command                                                | Handoff                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------- |
| Domain value, validator, projection/hash  | Focused module test                                                        | `pnpm test test/domain/<file>.test.ts`                         | `pnpm check`                                              |
| Discovery, index, list/show, retention    | Application workflow with fake ports; SQLite only when persistence matters | `pnpm test test/application/<file>.test.ts`                    | `pnpm check`                                              |
| Codex path, state, rollout, normalization | Adapter test; shared conformance when the port changes                     | `pnpm test test/adapters/codex/<file>.test.ts`                 | `pnpm check`                                              |
| Cursor path, store/JSONL normalization    | Adapter test; shared conformance when the port changes                     | `pnpm test test/adapters/cursor/<file>.test.ts`                | `pnpm check`                                              |
| Migration, FTS, lease, transaction, WAL   | Real SQLite/filesystem integration                                         | `pnpm test test/infrastructure/<file>.test.ts`                 | `pnpm check`                                              |
| Query filters, ranking, cursor, context   | Query contract/corpus; SQLite only for SQL/FTS behavior                    | Focused search or entry-query application/infrastructure tests | `pnpm check`                                              |
| Structured selection, JSON/JSONL, export  | Pure application/CLI contracts; process only for wiring/stream boundaries  | Focused export and structured CLI tests                        | `pnpm check`                                              |
| CLI option, report, exit, rendering       | In-process CLI; child process only for process behavior                    | `pnpm test test/cli.test.ts`                                   | `pnpm check`                                              |
| Skill route, metadata, prompt boundary    | Skill contract plus evaluator-owned generic forward case                   | `pnpm test test/skill-contracts.test.ts`                       | `pnpm check`                                              |
| Import boundary                           | Dependency checker; self-test if checker behavior changes                  | `pnpm deps:check`                                              | `pnpm check`                                              |
| Markdown, links, contributor routes       | Docs formatting and structural contract                                    | `pnpm check:docs`                                              | `pnpm check` locally; docs-only CI uses `pnpm check:docs` |
| Build, entrypoint, tarball, install       | Existing dist/package smoke; focused tests own branches                    | `pnpm build`, then `pnpm smoke:dist` or `pnpm smoke:package`   | `pnpm check`                                              |
| Release workflow or public artifact       | Parsed workflow/config contracts plus release-package smoke                | Focused release contract tests and one local qualified tarball | `pnpm check`, then protected release jobs                 |

Do not repeat one acceptance criterion at every layer.

The current document-digest proof stays at its stable owners: domain tests cover
the closed projection, relevant RFC 8785/JCS vectors, Unicode/order sensitivity,
private-field exclusion, and fragment-fed large-document hashing; application
tests cover immutable post-validation admission; SQLite tests cover the strict
32-byte codec, atomic body/digest replacement and rollback, same-snapshot
attribution, direct summary reads, checksum refusal, and canonical read/health
failure on mismatch. Digest corruption is not tested as FTS repair because it is
canonical corruption.

Structured-output proof stays at its stable owners. Application tests cover
Unicode/code-point selection, raw UTF-8 accounting, default/full bounds,
relations/entries/segments, immutable snapshots, and provider-free absent or
missing/unknown behavior. Query tests verify the matched segment's full content
hash before excerpting. CLI tests lock every exact schema-1 JSON object and JSONL
record, optional/null rules, order, equivalent evidence, recursive forbidden
fields, trust labels, format-neutral cursors, strict usage, streams/exits, and
the injected encoded-size boundary. The one shared dist/package workflow adds
only a representative JSON list/search/entries/show and line-by-line JSONL export
journey; focused tests own the edge-case matrix.

Cursor JSONL fallback proof stays at three seams: adapter tests own exact paths,
precedence, streaming syntax, mutation, and reduced evidence; application tests
own format replacement and last-good behavior; one SQLite/distribution journey
owns composition and durable retrieval. Do not repeat every query and
maintenance command for the fallback.

Agent Skill proof has three distinct owners. The deterministic contract locks
the exact packaged layout, metadata, direct reference routing, one binding
evidence protocol, shipped commands, and mutation/privacy limits. The package
smoke checks the installed copy outside the checkout byte-for-byte and resolves
every reference. Fresh-agent forward evaluation uses only generic isolated
evidence and the user question; expected routes and grading facts remain outside
the agent prompt. It covers all seven routes, including context transfer and the
workflow-audit eligibility/use/process/outcome matrix. Model behavior is
evaluation evidence, not a deterministic CI assertion, so prompt revisions stay
surgical and rerun only affected cases.

Run `node scripts/prepare-sessions-skill-forward-test.ts` in an interactive
terminal. Its one-line JSON names the empty agent workspace, installed skill,
packaged `sessions` launcher, and case prompts. Keep the process open while fresh
agents run, then send one input line to clean the complete temporary environment.
This opt-in evaluation is outside `pnpm check`.

The V1 bounds are grounded in privacy-safe aggregate evidence, not committed
transcripts. An audit of 1,444 retained sessions found at most 102 segments in a
first-50-entry window; after the 8 KiB per-text cap, 1,443 of 1,444 windows were
at or below the 256 KiB text budget. Separate structural maxima were 80 bytes for
source-instance/target IDs, 36 for native/target IDs, 8 for adapter versions, 19
for entry kinds, 29 for call IDs, 33 for tool names, 23 for namespaces. These are
design evidence, not admission limits or release thresholds. The encoded 16 MiB
cap remains the final bound. Never record the audited paths, identities, hashes,
or transcript values.

## Authoring

| Concern         | Guidance                                                                                                                                                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Placement       | Mirror the owner under `test/domain`, `application`, `adapters`, or `infrastructure`; use `test/contracts` for reusable guarantees, `test/fixtures` for generated builders, and root `test/*.test.ts` only for cross-layer contracts.                     |
| Shape and names | Name behavior plus consequence. Keep one coherent journey together; use `test.each` for a real invariant matrix. Existing shallow `describe` and cleanup-only `afterEach` use need not be normalized; prefer top-level tests and local setup in new work. |
| Runner          | Vitest uses Node, imported APIs, automatic mock restoration, and a 30-second timeout. Reset mocks manually only for a mid-workflow boundary.                                                                                                              |
| Setup and state | Factories return ready-to-run sources, documents, or lifecycles. Use generic synthetic data, deterministic IDs/clocks, in-memory SQLite when file lifecycle is irrelevant, and explicit temporary `CODEX_HOME`/`SESSIONS_DATA_DIR`.                       |
| Resources       | Use `mkdtemp` under the OS temp directory. Close databases/readers/writers/workers/processes, then clean with `try/finally`, fixture `dispose()`, or a cleanup hook. Add `using` only when real disposal exists.                                          |
| Assertions      | Match stable structured contracts exactly and unrelated fields partially. Also assert forbidden effects: unchanged provider bytes, absent state, retained rows, empty stderr, or no private paths.                                                        |
| Subprocesses    | Prefer `runCli`; spawn only for a real process seam. Isolate cwd/env, capture status/stdout/stderr, expect quiet success, and include useful failure diagnostics. Await real state rather than sleeping.                                                  |
| Prose/config    | Test parsed configuration, schemas, routes, metadata, rendered structure, or the smallest safety sentinel. Do not pin full prompts, help, docs, descriptions, or instructional copy without durable meaning.                                              |

## Smoke and live policy

The current dist and package smokes spawn production-built entrypoints against
generated Codex and Cursor fallback state plus isolated Sessions data. The shared workflow proves
JSON query commands, one namespaced-tool entry inventory, and JSONL export one
physical line at a time, while
preserving provider-tree immutability and the existing lifecycle journey. The
package smoke installs offline from the populated pnpm store. Both clean
temporary roots in `finally` and capture command/assertion context on failure.
The package smoke also checks that only the ten intended Agent Skill files ship,
that the installed copy is independent of the checkout, and that its metadata
and direct references are valid.

Release qualification is separate from routine offline package smoke. It runs
the full gate at the exact release revision, builds and hashes one tarball, then
tests those same bytes on Linux, macOS, and Windows through ordinary global npm
installation and pinned `npx`. Only after all three pass may the protected
OIDC job publish that artifact. Registry and provenance checks are release
operations, not deterministic `pnpm check` dependencies.

Add or broaden a smoke only for a critical journey that faster layers cannot
credibly prove. Keep edge-case matrices focused. Use production-supported seams
and local fakes; isolate any repositories, stores, roots, ports, and fake
credentials. Clean on success and keep failure output bounded, or retain one
bounded diagnostic root with an explicit cleanup protocol.

No authenticated or networked live protocol exists today. The two local
provider-read measurements are opt-in, credential-free, use disposable targets,
redact output to aggregates, and clean up owned state. Keep them outside Vitest,
pre-commit, `pnpm check`, and routine CI. Live results are operational evidence,
not deterministic regression coverage.

`pnpm measure:indexing` is the deterministic, provider-free stable-index
baseline. It compares control and timed runs from the same generic seeded
library, requires exact semantic equality, and prints aggregate timings only.

`pnpm measure:manifest` is the deterministic, provider-free manifest baseline.
It indexes 2,000 generic revisions across three source instances through the
production SQLite writer, then reads the complete cohort twice through the
production query repository. The run requires exact repeated equality, binary
identity order, capture scope, roots, occurrence-based metrics, and a bounded
encoded result. During both reads a SQLite authorizer denies transcript-table
access and writes, and a fixed upper bound on select authorization guards the
set-based query shape from N+1 drift. It constructs no provider adapter, prints
only aggregate counts and timings, has no timed threshold, and stays outside
`pnpm check`.

`pnpm measure:indexing:codex -- --allow-provider-read` is the Codex local
provider-read measurement. It is macOS/Linux-only and fails before provider
resolution elsewhere. It uses the production Codex adapter, exhausts its full
discovery generation, indexes only a fixed 120-candidate cohort into a mode-0700
temporary Sessions library, and uses no credentials. The result is discarded
unless every discovery and changed read receives the exact workspace reference
owned by that run. Seed read-workspace calls must equal changed-read timing calls
and cover at least the 120-session cohort; the stable run must be fully unchanged
with zero reads. The complete selected observations must agree, and every selected
rollout must be byte-identical at seed discovery, stable discovery, and final
verification. State database/WAL safety comes from the production adapter's
no-follow hash-copy-verify snapshot; unrelated Codex activity is allowed between
runs. Output contains aggregate counts, booleans, and timings only. The exact
temporary root is removed in `finally` and INT/TERM cleanup; an uncatchable
process or machine failure can leave sensitive temporary Sessions data. Run it
only with explicit live-data authority and outside routine gates. It is the M11a
operational exit gate after focused tests and `pnpm check`; deterministic tests
remain authoritative for forced staging, cleanup, rollback, and lease failures.

`pnpm measure:indexing:cursor -- --allow-provider-read` applies the same
authority, temporary-state, workspace-delivery, aggregate-output, and cleanup
rules to the production Cursor adapter. It sorts the complete discovery
generation by native ID, preflights supported candidates, and refuses a cohort
smaller than 120. The seed run must update all 120 and the stable run must report
all 120 unchanged with no changed reads or other outcomes. Selected chat,
agent-store/catalog, or JSONL physical inputs are resolved from the production
inventory and hashed with no-follow stable open/stat checks at seed discovery,
after seed, stable discovery, and final verification. Any candidate-signature or
byte drift fails the check. Output contains only aggregate preflight failures,
counts, selected file/byte totals, health, clean-writer state, workspace
delivery, and timings.

## Verification

Iterate with one focused path:

```bash
pnpm test test/application/run-index.test.ts
pnpm test test/application/search-sessions.test.ts
pnpm test test/adapters/codex/source.test.ts
pnpm test test/application/codex-vertical-slice.sqlite.test.ts
pnpm test test/cli.test.ts
```

Use `pnpm test:watch <path>` for watch mode. Add `pnpm typecheck`,
`pnpm deps:check`, or `pnpm check:docs` when that contract changes.

`pnpm check` is the local handoff gate: format, lint, dependency boundaries,
types, Vitest, build, dist smoke, and package smoke. Repository policy requires
it after the focused docs gate even for documentation-only local handoff.

CI classifies the complete diff. Markdown-only changes run `pnpm check:docs` on
Ubuntu while required macOS/Windows contexts take their skip path. Any
non-Markdown path runs `pnpm check:ci` (currently `pnpm check`) on all three.
The main ruleset requires all three `Check (<os>)` contexts.

Run a smoke directly only while changing its build/install/process boundary; the
full gate already runs both. Run a live check only when an accepted plan names it
and grants the required authority. Report focused checks, the final gate, and any
skipped smoke/live check with its reason.

## Maintenance

- Turn repeated review feedback into this guide, focused tests, lint/schema
  rules, scripts, or CI—in that order of increasing enforcement cost.
- Pre-commit formats/lints staged files and typechecks. It is hygiene, not done.
- Avoid drifting inventories: `package.json`, `vitest.config.ts`, and
  `.github/workflows/ci.yml` own execution; [commands](commands.md) owns effects.
- Update this guide for a genuinely new layer. Keep current/planned behavior
  explicit and do not normalize unrelated tests.
