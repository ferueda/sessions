# Testing

## Purpose

Tests are part of the Sessions engineering harness. They keep canonical data,
read-only provider boundaries, local persistence, CLI behavior, and package
delivery visible while humans and agents change the repository.

The goal is not maximum test count. Choose the cheapest stable proof that would
fail when durable intent breaks. This document is the canonical testing strategy
and authoring guide. Other contributor documents should link here instead of
maintaining another layer taxonomy. [`package.json`](../../package.json) owns
executable commands, and the [repository command inventory](commands.md)
documents their effects.

## Core principles

### Encode durable intent

A test should protect a behavior, invariant, or public contract. Prefer
assertions about:

- canonical identities, documents, observations, and source-presence state;
- provider-neutral application decisions and read-only source behavior;
- SQLite transactions, lifecycle fencing, permissions, and retained evidence;
- CLI exit codes, stream discipline, structured reports, and bounded rendering;
- package contents, installed entrypoints, and repository-owned documentation
  routes.

Avoid private call order, broad snapshots, incidental formatting, and guarantees
already enforced by strict TypeScript. Do not pin prose merely because it appears
in a prompt, help description, configuration file, or contributor document. Test
the parsed behavior, rendered structure, stable safety rule, or public contract
that makes the wording important.

### Keep the suite small and high-signal

Use the narrowest existing stable seam that proves the acceptance criterion or
realistic failure mode. Add another layer only when it can fail for a materially
different reason. A pure function does not need a spawned CLI test; a migration
or process-isolation guarantee cannot be proved by a mock.

Keep related assertions in one coherent workflow test. Set up the world, perform
the meaningful actions, and assert important intermediate and final outcomes.
Do not split one indexing, retention, or CLI journey into tiny cases solely to
reach one assertion per test.

### Make setup explicit and isolated

Prefer setup local to the test and factories that return ready-to-run sources,
documents, lifecycles, or temporary roots. Avoid hidden order dependencies,
broad shared fixtures, and mutable state shared between cases. Hooks are
appropriate for unavoidable cleanup, not for constructing a world readers must
discover elsewhere.

Tests must not read a contributor's Codex history or Sessions library. Use
generated provider fixtures, in-memory SQLite, or temporary roots with explicit
`CODEX_HOME` and `SESSIONS_DATA_DIR` overrides. Use deterministic identities and
injected clocks when they clarify the contract. Do not use arbitrary sleeps.

### Keep routine proof local and deterministic

Vitest, integration tests, and both current smokes run without provider services,
external credentials, or public-network calls. Dependency installation and
publishing are separate networked operations. A future check that genuinely
needs authenticated external behavior belongs in an explicit opt-in protocol,
not the default suite or ordinary CI.

### Make regression coverage earn its cost

For a bug, add coverage at a stable seam when it protects a realistic repeat
failure. Reproduce the root failure rather than one incidental symptom. Do not
add a slow or brittle test only to record a low-probability one-off. State the
reason when useful regression proof would be disproportionate.

Keep a high bar for new SQLite integrations, subprocess checks, distribution
smokes, and live protocols. Faster tests should own edge-case matrices; broader
tests should prove only the cross-boundary behavior they uniquely observe.

## Test layers

All current Vitest suites live under `test/`. The runner also permits
`src/**/*.test.ts`, but the existing repository convention is the mirrored
`test/` tree.

| Layer                             | Current placement and seam                                                                                            | Use it to prove                                                                                                                                               |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain/module                     | `test/domain/**` and focused pure application tests                                                                   | Canonical validation, hashes, identity codecs, bounds, parsing, and deterministic value behavior                                                              |
| Application workflow              | `test/application/**` with injected ports and fakes such as `createFakeIndexingSource`                                | Discovery admission, indexing/reconciliation decisions, last-good behavior, reports, list/show/forget orchestration, and failure semantics                    |
| Source adapter and conformance    | `test/adapters/codex/**`, reusable contracts in `test/contracts/**`, and generated inputs in `test/fixtures/codex/**` | `probe`/`discover`/`read`, complete fingerprints, frozen versus live inputs, normalization, malformed formats, sanitized failures, and provider non-mutation  |
| SQLite and filesystem integration | `test/infrastructure/**` and application `*.sqlite.test.ts` files                                                     | Real migrations, FTS5, transactions, permissions, leases, WAL behavior, cleanup, retained canonical rows, and reader/writer lifecycle                         |
| CLI contract and process boundary | `test/cli.test.ts`, `test/cli-render.test.ts`, and focused root `test/*-no-persistence.test.ts` files                 | In-process grammar/rendering by default; separate-process composition, environment, streams, and no-side-effect guarantees only when process behavior matters |
| Repository self-contract          | `test/architecture.test.ts`, `test/ci-change-scope.test.ts`, and `test/docs-contracts.test.ts`                        | Dependency direction, CI path classification, required document routes, resolvable links, concise agent guidance, and private-path exclusion                  |
| Distribution smoke                | `scripts/smoke-dist.ts` plus `scripts/smoke-m5-workflow.ts`                                                           | The compiled binary's help/version and one synthetic Codex index/list/show/forget/clear journey through spawned commands                                      |
| Package smoke                     | `scripts/smoke-package.ts` plus the same M5 workflow                                                                  | The allowlisted tarball, offline install from the populated pnpm store, installed binary independence, and packaged command wiring                            |

There is no separate browser/E2E framework, system-smoke lane, networked provider
test, or authenticated live-test command today. Search/export, Cursor, and the
packaged Agent Skill remain planned, so do not describe their future contracts as
current coverage.

## Proof decisions

The final column names the normal handoff gate. Use the focused command while
iterating, then escalate unless the row explicitly describes the CI-only
documentation optimization.

| Change                                                             | Preferred proof                                                                                         | Focused command                                | Handoff gate                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------ |
| Canonical value, validator, hash, or identity rule                 | Focused domain/module test                                                                              | `pnpm test test/domain/<file>.test.ts`         | `pnpm check`                                                       |
| Discovery, index, list/show, retention, or failure decision        | Application workflow with an injected fake port; add real SQLite only when persistence is the risk      | `pnpm test test/application/<file>.test.ts`    | `pnpm check`                                                       |
| Codex path, state, rollout, fingerprint, or normalization behavior | Adapter test and the shared source contract when the port guarantee changes                             | `pnpm test test/adapters/codex/<file>.test.ts` | `pnpm check`                                                       |
| Migration, FTS, lease, transaction, permission, or WAL behavior    | Focused real-SQLite/filesystem integration                                                              | `pnpm test test/infrastructure/<file>.test.ts` | `pnpm check`                                                       |
| CLI option, exit code, report, or rendering                        | In-process CLI contract; use a child process only for actual composition or stream/environment behavior | `pnpm test test/cli.test.ts`                   | `pnpm check`                                                       |
| Production import boundary                                         | Dependency checker plus its self-test when checker behavior changes                                     | `pnpm deps:check`                              | `pnpm check`                                                       |
| Contributor Markdown, links, or repository routes                  | Documentation formatting and structural docs contract                                                   | `pnpm check:docs`                              | `pnpm check` locally; documentation-only CI runs `pnpm check:docs` |
| Build output or compiled entrypoint                                | Existing distribution smoke; focused unit/CLI tests still own branches                                  | `pnpm build && pnpm smoke:dist`                | `pnpm check`                                                       |
| Tarball allowlist, offline install, or installed binary            | Existing package smoke                                                                                  | `pnpm build && pnpm smoke:package`             | `pnpm check`                                                       |
| Real provider or authenticated external behavior                   | No current automated layer; require a separately reviewed opt-in operator protocol before adding one    | No supported command today                     | Never a substitute for `pnpm check`                                |

Do not repeat the same acceptance criterion at every layer. For example, keep
index failure permutations in application tests, transaction guarantees in
SQLite tests, and only the critical installed journey in the smokes.

## Placement and authoring

### Files and names

- Match the owning production area under `test/domain/`, `test/application/`,
  `test/adapters/`, or `test/infrastructure/`.
- Put reusable adapter guarantees in `test/contracts/` and generated,
  privacy-safe builders in `test/fixtures/`. A contract implementation remains a
  normal `*.test.ts` entrypoint that registers the shared suite.
- Use a root `test/*.test.ts` file for a genuinely cross-layer CLI, architecture,
  documentation, or no-persistence contract.
- Keep broad built-artifact journeys in `scripts/smoke-*.ts`, outside Vitest
  discovery and watch mode. Do not add a second E2E directory or runner.
- Use `*.sqlite.test.ts` where an application workflow deliberately selects real
  SQLite. Infrastructure tests already imply that boundary and do not need the
  suffix mechanically.
- Name tests as behavior plus consequence, such as
  `incomplete discovery preserves retained sessions` or
  `list does not resolve provider configuration`.

The current suite commonly uses one shallow `describe` and some cleanup-only
`afterEach` registries. Preserve useful local consistency; do not churn existing
tests merely to normalize style. For new or materially changed coverage, prefer
top-level `test(...)`, setup inside the test, and the least nesting that keeps a
large contract navigable. Use `test.each` for a real invariant across an input
matrix, not to hide unrelated scenarios.

Vitest runs in the Node environment with globals disabled, automatic mock
restoration, and a 30-second test timeout. Import the APIs a test uses. Rely on
the configured restoration between cases; reset a mock manually only when one
workflow needs a clean midpoint.

### Factories, resources, and cleanup

Use factories such as the synthetic indexing source and Codex source fixture as
patterns: return the selected adapter and the controls the test needs rather than
installing globals. Keep fixture data generic and obviously synthetic. Never copy
a private transcript, workspace path, credential, or downstream repository into
the suite.

Use `mkdtemp` beneath the operating-system temporary directory for filesystem
state. Use in-memory SQLite when file lifecycle is not the contract. When cleanup
is real, make it explicit with `try/finally`, a fixture `dispose()` method, or a
cleanup-only lifecycle hook. A disposable helper may implement `using` or
`await using` when that makes ownership clearer; do not add disposal ceremony to
an object with nothing to release.

Close databases, readers, writers, workers, and child processes before removing
their roots. Cleanup should be idempotent and must never target ambient provider
or application data. Tests that deliberately assert failure should still clean
their resources.

### Assertions and diagnostics

Prefer exact assertions for stable public values and partial matches for fields
irrelevant to the test. Assert forbidden effects as well as desired results when
privacy or authority matters: unchanged provider bytes, absent Sessions state,
retained canonical rows, empty stderr, or no local paths in persisted output.

For structured reports, parse JSON and assert schema version, command, outcome,
and relevant fields. Avoid large snapshots and string blobs. Human output may use
small stable sentinels when the text itself is the CLI contract; do not freeze
whole paragraphs to prevent harmless edits.

Prefer calling `runCli` with captured output for argument and rendering behavior.
Spawn `process.execPath` only when a separate process is the seam. Give the child
an isolated working directory and explicit environment, capture status/stdout/
stderr, expect silence on success where required, and include bounded captured
output in a failure message. Await promises, workers, filesystem changes, and
durable state directly instead of sleeping.

Documentation, configuration, prompt, help, and future skill text require the
same discipline:

- Assert parsed configuration precedence and failure behavior, not TOML wording.
- Assert relative links, required routes, metadata, schemas, or rendered
  structure rather than an inventory copied into a test.
- When exact wording carries a public safety or privacy rule, assert the smallest
  stable sentinel that proves it.
- Do not test descriptions, usage hints, or instructional prose with no durable
  behavioral meaning.

## Smoke and live-test policy

The current distribution and package smokes are deliberately outside ordinary
Vitest discovery. Both spawn a production-built entrypoint against generated
Codex state and an isolated `SESSIONS_DATA_DIR`; neither reads a contributor's
provider data or uses credentials. The package smoke packs with lifecycle scripts
disabled and installs the tarball offline from the already populated pnpm store.
Both clean their temporary root in `finally` and surface captured command/assertion
context on failure.

Add or broaden a smoke only when a product-critical journey crosses process,
build, install, or transport seams that faster layers cannot credibly prove.
Keep one representative journey broad and keep malformed-input, retry, and edge-
case matrices in focused tests. Use only production-supported seams plus local
generated providers or fakes; never weaken production validation for a test.

Every broader smoke must isolate any repositories, stores, application data,
provider roots, ports, and fake credentials it creates. Clean them on success.
On failure, print bounded diagnostics and either clean immediately, as current
smokes do, or retain one clearly identified bounded diagnostic root when the
operator protocol explicitly promises cleanup.

Authenticated live verification is opt-in operational evidence, not deterministic
regression coverage. No such protocol exists in Sessions today. Before adding
one, document the authority, required credential names and source (never their
values), disposable target, stop conditions, cleanup, and redaction behavior.
Keep it out of Vitest discovery, pre-commit, `pnpm check`, and routine CI.

## Verification workflow

### Targeted iteration

Pass a path directly to the existing Vitest script:

```bash
pnpm test test/application/run-index.test.ts
pnpm test test/adapters/codex/source.test.ts
pnpm test test/application/codex-vertical-slice.sqlite.test.ts
pnpm test test/cli.test.ts
```

Use `pnpm test:watch <path>` for a local watch loop. Add the scoped static or
documentation command when its contract changed:

```bash
pnpm typecheck
pnpm deps:check
pnpm check:docs
```

Run `pnpm smoke:dist` or `pnpm smoke:package` directly only when iterating on the
boundary it owns; both require current build output, and the package smoke also
requires dependencies in the pnpm store. The supported focused sequence is
`pnpm build && pnpm smoke:dist` or `pnpm build && pnpm smoke:package`.

### Handoff and CI

`pnpm check` is the repository's normal local handoff gate. It runs, in order,
format checking, lint, dependency boundaries, type checking, Vitest, build,
distribution smoke, and package smoke. `pnpm check:ci` is currently an exact
alias used by CI. Because the root repository policy defines `pnpm check` as
done, documentation-only local handoff also runs it after the focused docs gate.

CI classifies the complete pull-request or push diff through
`scripts/classify-ci-changes.ts`:

- If every changed path ends in `.md`, Ubuntu installs dependencies and runs
  `pnpm check:docs`; the macOS and Windows jobs complete through their documented
  skip path.
- If any changed path is not Markdown, Ubuntu, macOS, and Windows each run
  `pnpm check:ci`, and therefore the full local gate.

The active main-branch ruleset requires the three `Check (ubuntu-latest)`,
`Check (macos-latest)`, and `Check (windows-latest)` contexts. Workflow YAML,
`scripts/classify-ci-changes.ts`, and `package.json` remain the executable sources
of truth; update this explanation when their contract changes.

The existing distribution and package smokes are already part of every full
handoff/CI gate, so ordinary changes do not need another system smoke. No current
change requires live credentials. If a future boundary can only be verified
live, run its explicit opt-in protocol in addition to—not instead of—the normal
gate and report it separately.

Before handoff, report the focused checks, the final gate, and any skipped smoke
or live verification with the concrete reason.

## Maintenance

- Repeated review feedback should become the smallest durable guardrail: clarify
  this guide or an owning contract, add focused regression coverage, add lint or
  structural enforcement, then add a script or CI rule when repeatable execution
  is the missing boundary.
- Pre-commit runs staged formatting/lint fixes and the full typecheck. It is fast
  hygiene, not the definition of done and not a substitute for `pnpm check`.
- Do not duplicate complete command or test inventories here.
  `package.json`, `vitest.config.ts`, and `.github/workflows/ci.yml` own executable
  discovery and gates; [commands](commands.md) owns the side-effect summary.
- When adding a genuinely new proof layer, update this canonical guide and link
  to it. Do not create a competing taxonomy in another contributor document.
- Apply new authoring expectations to new or materially changed tests. Preserve
  intentional framework conventions and avoid unrelated suite normalization.
