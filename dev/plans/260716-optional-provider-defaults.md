# Make registered providers optional by default

## Goal

Let Sessions ship several adapters without making every provider a runtime
requirement. A provider being registered means Sessions can use it; it does not
mean the provider is installed.

When `sessions index` omits `--source`, unavailable providers are reported and
skipped. Ready providers are indexed normally. An explicitly selected provider
remains strict. `doctor` treats an unavailable provider as an informational
successful check, while unreadable or invalid probes remain failures.

## Changes

1. `src/application/run-index.ts`, `src/application/index-report.ts`, and the
   smallest focused source-probe helper — add an implicit optional-source mode
   without provider branches. Preflight registered sources before writer open.
   In implicit mode, a valid `unavailable` probe produces a `skipped` source
   report and is not passed to the writer. Ready, unreadable, invalid, and
   throwing probes remain attempted so real provider faults cannot be hidden.
   If every source is unavailable, return a complete aggregate report without
   opening or creating the Sessions library.

   Keep a second probe inside each attempted source run. A source that changes
   after preflight therefore fails through the existing incomplete-run path.
   The preflight is only an availability selection snapshot, not freshness or
   capture evidence.

2. Extend the schema-1 index report with one exact skipped-source contract:
   `status: "skipped"`, `reason: "source-unavailable"`, zero counts and items,
   `coverage.status: "not-attempted"`, and observed start/finish timestamps.
   Add exact top-level `skippedSources`; keep `incompleteSources` limited to
   attempted sources that failed. Preserve deterministic source ordering and
   safe aggregate counts. Human output must say that the provider was skipped;
   it must not render the operation as captured or complete coverage.

3. `src/bin/sessions.ts` — call indexing in implicit optional mode only when
   `--source` is absent. `--source <kind>` remains required mode: unavailable,
   unreadable, invalid, or failed probes produce the current incomplete report
   and exit `1`; unknown kinds remain usage exit `2`. A mixed implicit run exits
   `0` only when every attempted source completes; skipped unavailable sources
   do not make it incomplete.

4. `src/application/source-diagnostic.ts` — make a valid `unavailable` provider
   probe an informational passing diagnostic. `ready` passes; `unreadable`,
   invalid, and throwing probes fail. Keep `probeStatus` exact so JSON and human
   output remain honest. `paths` continues listing every registered provider and
   its real probe status without changing exit behavior.

5. Focused application, CLI, no-persistence, and composition tests — prove:
   all-unavailable implicit indexing emits skipped reports, exits `0`, and does
   not open/create the library; mixed ready/unavailable indexing captures only
   the ready source; unreadable and invalid sources are not skipped; a source
   that disappears after preflight becomes incomplete; explicit unavailable
   selection remains strict; ordering/counts/timestamps are deterministic; and
   current single-ready-Codex behavior is unchanged.

6. `docs/project-intent.md`, `docs/contributing/architecture.md`,
   `docs/contributing/indexing.md`, `docs/reference/cli-contract.md`, and the V1
   roadmap — record the provider registry rule and exact report/exit semantics.
   State that optional means “absence is allowed,” not “installed but broken is
   ignored.” Land this provider-neutral prerequisite before registering Cursor.

## Verify

- Focused application, CLI, no-persistence, and docs contract tests for the
  cases above.
- Built and packed CLI smoke with one ready synthetic source plus one unavailable
  synthetic source, followed by an explicit unavailable-source failure.
- `pnpm check`

## Boundaries

- No Cursor or Codex parser change and no provider-specific branch outside
  composition.
- No automatic installation, configuration, network request, provider write,
  background discovery, or remembered default provider.
- No skipping unreadable, malformed, invalid, throwing, or explicitly selected
  providers.
- No change to canonical storage, freshness, reconciliation, query/export,
  capture-scope, or adapter identity.
