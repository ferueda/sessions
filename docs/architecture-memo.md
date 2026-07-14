# Standalone Sessions architecture memo

- Status: accepted design baseline
- Date: 2026-07-13
- Last updated: 2026-07-14
- Scope: standalone repository through V1

## Executive summary

Build Sessions as a new local-first product, using the Harness implementation as evidence and reusable parser material rather than as a codebase to clean up in place.

The core owns a provider-neutral session model, indexing lifecycle, SQLite/FTS5 storage, and structured query semantics. Cursor, Codex, and future adapters only probe, discover, read, and normalize their sources. The CLI and Agent Skill consume the same application services. Provider histories remain read-only; the canonical index is the only source for list, search, show, and export.

The public delivery target is an npm package named `@ferueda/sessions` with a `sessions` binary, compiled JavaScript, Node.js 24.16 or newer, package-install smoke tests, cross-platform CI, and later release-please plus npm trusted publishing and provenance.

## Context

The existing [Harness Sessions skill](https://github.com/ferueda/harness/tree/fead436b9c810c3f0a3952789f0716765ddbc8f9/skills/sessions) proved the value of local transcript search and supplied real Cursor/Codex parsers, fixtures, output patterns, and retrospective workflows.

It also revealed boundaries that should not cross into a general product:

- The command entrypoint mixes command definition, orchestration, rendering, filtering, and provider construction.
- Provider interfaces own indexing, cache access, querying, transcript reads, and turn iteration.
- Concrete adapters write their own cache snapshots.
- Core types close over known providers.
- Analysis includes Harness-specific workflow evidence and automation/subagent policy.
- Some views reopen mutable source histories instead of reading one canonical snapshot.
- Installation symlinks TypeScript from a source checkout rather than delivering an ordinary public CLI.

Those constraints are useful migration evidence, not the standalone architecture.

## Product and design principles

1. **Local by default.** No transcript leaves the machine during ordinary use.
2. **Facts before inference.** Preserve source evidence and label classification confidence.
3. **One canonical engine.** Index, reconcile, search, show, and export behave the same for every adapter.
4. **Passive adapters.** Source-specific code translates inputs; it does not choose business policy.
5. **Honest interfaces.** Current help and docs expose only working behavior. Planned behavior is visibly planned.
6. **Scriptable delivery.** Stable exit codes, bounded output, versioned structured formats, and clean streams.
7. **Rebuildable state.** The index is disposable local derived data, while source histories remain authoritative inputs.
8. **One upstream after parity.** Standalone Sessions becomes the implementation owner; Harness keeps a thin pinned integration.

## Target system

```mermaid
flowchart LR
  User["Human or agent"] --> CLI["CLI presentation"]
  CLI --> App["Application services"]
  App --> Domain["Canonical domain"]
  App --> SourcePort["Session source port"]
  App --> IndexPort["Index repository port"]
  Cursor["Cursor adapter"] --> SourcePort
  Codex["Codex adapter"] --> SourcePort
  Future["Future adapter"] --> SourcePort
  SQLite["SQLite + FTS5"] --> IndexPort
  Compose["Composition root"] --> CLI
  Compose --> Cursor
  Compose --> Codex
  Compose --> SQLite
```

Arrows represent dependencies on contracts, not runtime call direction. Domain code imports no outer layer. Application code imports domain and its own ports. Adapters and SQLite implement inward-facing ports. Only the composition root knows concrete implementations.

### Layer ownership

| Layer           | Owns                                                                                           | Must not own                                              |
| --------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Domain          | Canonical identities, sessions, entries, content, provenance, lineage, query values            | Provider paths, SQLite, CLI formatting                    |
| Application     | Indexing, reconciliation, query/show/export use cases, transaction boundaries, error semantics | Provider parsing, SQL details, terminal presentation      |
| Source adapters | Availability probe, discovery, complete-input fingerprints, source reads, normalization        | Index writes, ranking, filters, output, business analysis |
| Storage         | Migrations, canonical persistence, FTS tables, transactions, repository implementation         | Provider cases, source discovery, terminal output         |
| CLI             | Argument grammar, rendering, stream discipline, exit mapping                                   | Parsing provider histories, SQL, recurrence policy        |
| Composition     | Adapter registration and concrete wiring                                                       | Domain or query behavior                                  |
| Agent Skill     | Evidence-first playbooks over stable CLI commands                                              | Hidden data access, automatic source or project mutation  |

### Current module map and dependency enforcement

The implemented foundation through M4 uses this concrete layout:

```text
src/
  domain/
    session.ts
    session-validation.ts
    index-state.ts
  application/
    ports/session-source.ts
    ports/session-index.ts
    ports/runtime-diagnostic.ts
    ports/index-lifecycle.ts
    ports/index-health.ts
    ports/index-maintenance.ts
    validate-session.ts
    read-session-document.ts
    discover-sessions.ts
    run-index.ts
    index-report.ts
    clear-index.ts
    get-paths.ts
    run-doctor.ts
  infrastructure/
    runtime/node-diagnostic.ts
    state/
      paths.ts
      index-state-diagnostic.ts
    sqlite/
      database.ts
      migrations.ts
      migrations/0001-bootstrap.ts
      migrations/0002-canonical-repository.ts
      migrations/0003-writer-coordination.ts
      permissions.ts
      sqlite-diagnostic.ts
      fts5-security.ts
      read-snapshot.ts
      writer-lease.ts
      sqlite-writer-database.ts
      sqlite-session-index.ts
      sqlite-session-document.ts
      sqlite-session-state.ts
      sqlite-session-transaction.ts
      sqlite-index-run-result.ts
      sqlite-index-health.ts
      index-maintenance.ts
  cli/
    program.ts
    run.ts
  bin/sessions.ts
```

`src/bin/sessions.ts` is the only composition root and becomes `dist/bin/sessions.js`. Domain imports only domain. Application imports application/domain. Infrastructure imports inward but never adapters or CLI. Future adapters import application/domain but never infrastructure or CLI. CLI imports application/domain, never concrete infrastructure or adapters. The binary alone may import all layers to wire them.

Migration 2 and the internal SQLite repository persist and exactly reconstruct validated provider-neutral session documents, last-good and latest-observation freshness, bounded indexing-run diagnostics, collision-safe interned content, and derived FTS5 rows. Migration 3 adds singleton generation-based writer coordination. Repository replacements are atomic; every write is lease-fenced; expired takeover interrupts abandoned active runs; and snapshot readers remain non-migrating and sidecar-free.

The internal M4 application service now owns admitted source selection, complete discovery preflight, incremental reads, last-good failure behavior, exact-source reconciliation, and durable provider-neutral reports. Internal clear maintenance and immutable ready-index health inspection are also implemented. Concrete provider adapters, public index/clear routes, query behavior, and packaged skills remain planned work.

`scripts/check-dependencies.ts` enforces that graph for explicit static and dynamic relative imports and refuses a vacuous zero-module pass. Oxlint rejects cycles. Strict `tsconfig.json` checks source/tests/scripts directly; `tsconfig.build.json` compiles only `src/` to `dist/` and rewrites explicit TypeScript import extensions for Node.js. Tests and repository scripts sit outside the production graph.

## Canonical model

The canonical model is internal before 1.0. It is intentionally richer than a flattened transcript because origin, order, and lineage determine whether evidence is trustworthy.

### Source identity

A source instance combines:

- an open adapter kind such as `cursor` or `codex`;
- an instance identifier representing one installation/profile/source root;
- an opaque provider-native session ID.

The canonical printable ID is
`<kind>@<percent-encoded-instance-id>:<percent-encoded-native-id>`, for example
`cursor@default:opaque-id`. Adapter kinds are open lowercase slugs. Instance and
native IDs remain case-sensitive opaque values; the codec escapes delimiters and
never parses or Unicode-normalizes them for business meaning.

### Session

A session contains:

- source identity and opaque native ID;
- optional title and workspace;
- created/updated timestamps normalized to canonical UTC when observed;
- optional provider-neutral lineage relations;
- the complete-input fingerprint and adapter format version used to build it;
- ordered canonical entries.

### Entry

An entry is an ordered event with:

- contiguous zero-based ordinal within the session;
- provider-neutral event kind, including generic `tool-call` and `tool-result`
  kinds when the source exposes them;
- actor: human, model, tool, system, or unknown;
- canonical UTC timestamp when observed;
- optional exact source-observed tool name on a tool call;
- optional exact source-observed tool namespace on a tool call;
- optional provider call ID and relation to a tool call or another entry;
- a non-public source locator for diagnostics;
- ordered content segments.

Tool arguments and results remain faithful ordered content rather than
provider-owned analysis fields. A tool result links to its call through canonical
entry relations and the provider call ID when available; it does not duplicate
the call's tool name or namespace. Tool identity is evidence about an observed
event, not proof of a particular workflow's intent or success.

Tool name and namespace are valid only on `tool-call`; namespace requires a
name. Both preserve exact source-observed case and Unicode. Adapters never split a
qualified name, concatenate the two fields, or infer a missing namespace.

### Content segment

Canonical content is an ordered union of text and omitted segments. Every segment
retains origin, confidence, and sanitized source metadata needed to explain its
classification without duplicating raw provider payloads.

A text segment retains faithful canonical text plus its `sha256-utf8-v1` hash of
the exact UTF-8 bytes. Only text segments participate in FTS, content
deduplication, and recurrence measures.

An omitted segment records that unsupported non-text content existed at that
position, its broad class, and its provenance. It contains no copied bytes, data
URL, remote URL, local path, generated placeholder text, or content hash.
Adapters never fetch or open referenced media. Show/export can render the
omission explicitly without turning it into searchable transcript text.

Adapters preserve information they can prove and use `unknown` rather than guessing.

### Occurrences and recurrence

Every text-segment appearance is retained as an occurrence identified by session,
entry ordinal, and segment ordinal. Hash equality also requires exact text
equality, so even a digest collision cannot merge unequal content. Identical
content and known lineage allow the query layer to report three different support
measures:

- **occurrence count:** every appearance;
- **unique-content count:** distinct canonical content hashes;
- **unique-root count:** distinct known session roots.

No count is silently substituted for another. Unknown lineage remains unknown. This prevents copied prompts, forks, injected instructions, or delegated work from masquerading as independent repeated user intent.

## Source adapter contract

Each adapter implements three responsibilities:

1. `probe()` — return `ready`, `unavailable`, or `unreadable` plus sanitized
   adapter-owned source roots, without reading transcript content or mutating the
   source.
2. `discover()` — enumerate session candidates with identity, ordered input
   descriptors, an aggregate fingerprint covering every input needed by `read()`,
   and an adapter format version.
3. `read(candidate)` — parse and normalize one candidate into a complete canonical session document.

Contract rules:

- `kind` is an open string, never a closed Cursor/Codex union.
- Discovery order does not affect final results.
- Each input descriptor records its role, opaque diagnostic locator, and
  fingerprint. The aggregate includes ordered roles, locators, nullable record
  IDs, and fingerprints; any change invalidates it.
- Adapter format versions invalidate stale normalized documents after parser changes.
- Reads are deterministic for the same complete input. Adapters recheck every
  input before and after reading, or use an equivalent stable snapshot.
- Missing optional metadata degrades to absent/unknown values.
- Source-observed tool calls/results map to generic canonical entry kinds, exact
  tool names and namespaces when available, linked entries, and faithful
  argument/result content. Injected tool or skill catalogs remain injected
  content; their presence never implies invocation.
- Unavailable, unreadable, malformed, source-changed, and unsupported-format
  conditions return typed failures with safe diagnostics; they do not expose raw
  source errors or write partial index state.
- Adapters do not import storage, query, CLI, or one another.
- The shared conformance suite runs the same safety, determinism, fingerprint,
  mutation-race, provenance-fallback, and failure fixtures against every adapter.

This is an internal port in V1, not a stable external plugin ABI.

## Indexing and reconciliation

The implemented internal indexing service is the engine for the planned `sessions index` command, which will be the only operation that reads provider histories for persistence. The service owns this sequence:

1. Validate, deduplicate, and deterministically order exact selected source instances before opening a writer.
2. Start a durable source run, then probe the selected adapter.
3. Fully exhaust, snapshot, validate, deduplicate, and deterministically order discovery before session mutation.
4. Compare identity, complete-input fingerprint, and adapter format version with repository freshness.
5. Record unchanged candidates without calling `read()`.
6. Read and validate changed candidates, atomically replacing one complete canonical document and its search rows.
7. Preserve last-good rows after typed read failure and treat the failed candidate as seen.
8. Reconcile unseen canonical documents only after a complete scan for that exact source instance.
9. Finalize provider-neutral counts and bounded ordered diagnostics from durable repository state.

Properties:

- **Incremental:** unchanged complete inputs are skipped.
- **Idempotent:** reindexing unchanged sources leaves canonical results unchanged.
- **Transactional:** a session is old or new, never half-written.
- **Last-good preservation:** failed reads leave the prior indexed document available and report staleness.
- **Adapter-version aware:** parser corrections trigger controlled re-normalization.
- **Complete-scan reconciliation:** malformed, conflicting, wrong-source, or interrupted discovery mutates no sessions and removes nothing.
- **Single writer:** a renewable generation lease admits one high-level writer, and every repository mutation fences stale owners transactionally.
- **Recoverable:** a later writer can recover valid WAL state, interrupt abandoned runs after lease expiry, and reindex idempotently.

Probe/discovery/read failures are sanitized per-source outcomes and do not prevent later selected sources from running. Repository, lease, or finalization failures abort the invocation because persistence trust is lost. Sources run sequentially; M4 adds no daemon, parallel indexing, retries, or progress surface.

## Storage and search

SQLite is the canonical local store. FTS5 supplies lexical search. The schema separates source instances, sessions, relations, entries, content values, occurrences, index runs, migration metadata, and schema-v3 writer coordination while using FTS shadow tables only as derived search structures. Application query translation, ranking, and tokenizer tuning remain planned.

Planned application query values—not raw FTS syntax—define search:

- text;
- source/source-instance;
- workspace;
- time bounds;
- actor and origin;
- exact entry kind, exact source-observed tool name, and exact tool namespace;
- result limit and continuation cursor;
- optional exact session identity.

The query repository translates those values to SQL/FTS. Ranking details remain storage implementation, tested through provider-neutral query contracts. Show and export reconstruct canonical sessions from the index only.

Exact tool-name and tool-namespace filters select canonical tool-call entries
only and can be combined without concatenating identity fields. Bounded related
context can include directly linked tool-result entries even when they are
non-adjacent; those results retain the relation without receiving an invented
copy of the call's tool identity.

SQLite migrations are ordered, transactional, and forward-only for released versions. An incompatible or failed migration leaves the previous database recoverable and prints a remediation path; it never silently rebuilds user state.

## Privacy and local state

- Indexing is explicit. First run does not scan histories.
- Normal operation performs no network requests and emits no telemetry.
- Provider sources are opened read-only where the platform permits and are never modified intentionally.
- The index uses a new platform cache location and never shares the legacy Harness JSONL cache.
- POSIX directories are created with mode `0700`; database, WAL, and SHM files are constrained to `0600`. Windows uses the current user's profile-local cache and platform ACLs.
- `sessions paths` explains resolved source and index locations without dumping transcript content.
- `sessions index clear` removes Sessions-owned index files only.
- SQLite core `secure_delete` and FTS5 secure-delete are enabled when supported, but docs make no encryption or forensic secure-erasure claim.
- The index stores canonical content needed for faithful show/export, not entire raw provider payloads.

Detailed promises belong to [the privacy contract](privacy.md).

The only-owned-file clear path exists internally in M4 but is not a public command. It validates canonical path safety, acquires a `clear` lease and checkpoints a current schema, then removes only database/WAL/SHM files. It never recurses or opens provider paths. Registration and CLI rendering belong to M5.

## CLI contract

Current surface:

```text
sessions
sessions doctor [--format human|json]
sessions paths [--format human|json]
```

Remaining planned V1 surface:

```text
sessions index [--source cursor|codex]
sessions list [filters]
sessions search <text> [filters]
sessions show <source-instance:id> [--entry N --context N]
sessions export <source-instance:id> --format md|json|jsonl
sessions index clear
```

Behavioral rules:

- Human-readable output is default.
- JSON/JSONL are explicit and schema-versioned.
- Stdout carries requested results; stderr carries warnings, progress, and errors.
- Exit `0` means successful execution, including no matches; `1` means operational failure; `2` means invalid usage.
- Unknown flags and invalid values fail; they are not ignored.
- Potentially large output is bounded by default. `--full` is explicit.
- Color is optional and honors `NO_COLOR`.
- Filters have the same meaning for every source.

The exact current surface is generated help; stable semantics live in [the CLI contract](reference/cli-contract.md). No public command opens the implemented SQLite writer or clear maintenance yet.

## Doctor

`sessions doctor` performs real, read-only capability checks. It verifies the minimum Node runtime, creates an in-memory FTS5 table against the runtime's actual SQLite build, reports whether the FTS5 per-table secure-delete command is supported, and inspects index-path safety and schema state. Future adapter slices add non-mutating source probes.

Doctor supports human output through `sessions doctor` and JSON through `sessions doctor --format json`. The JSON contract is:

```json
{
  "schemaVersion": 1,
  "command": "doctor",
  "ok": true,
  "checks": [
    {
      "id": "node-runtime",
      "label": "Node.js runtime",
      "ok": true,
      "summary": "Node.js meets the minimum version",
      "details": {
        "version": "26.4.0",
        "minimumVersion": "24.16.0"
      }
    }
  ]
}
```

Check order is stable. Every check runs even when an earlier check fails. A thrown probe error becomes a sanitized failed check rather than aborting aggregation.

The complete human or JSON report is requested data and goes to stdout. All-pass exits `0`; any failed check exits `1`; both leave stderr empty. An unexpected failure outside aggregation writes a concise diagnostic to stderr, emits no fabricated report, and exits `1`. Invalid format or other usage exits `2` through normal CLI error handling.

The current checks are `node-runtime`, `sqlite-fts5`, and `index-state`. The SQLite capability probe uses `:memory:`. An uninitialized index passes with guidance. A ready index is checked through an immutable snapshot for bounded SQLite integrity, foreign keys, FTS structure/content/security, run-record readability, writer-lease state, and active/interrupted run counts. An active run requires a live indexing lease; interrupted history alone is informational. Doctor never resolves provider sources, creates or migrates the index, executes write-shaped FTS integrity commands, or persists data.

## Agent Skill design

V1 ships one primary `sessions` Agent Skill once the underlying search/show/export commands are stable. A single entry point avoids overlapping triggers while references provide focused playbooks:

```text
skills/sessions/
  SKILL.md
  agents/openai.yaml
  references/
    search-and-context.md
    retrospective.md
    preferences.md
    workflow-audit.md
    verification-audit.md
    handoff-continuity.md
    capability-discovery.md
```

Every playbook follows the same evidence discipline:

1. Run `doctor`; index only when the user has authorized it.
2. Start with narrow filters and bounded results.
3. Record commands, filters, canonical IDs, entries, and missing context.
4. Separate extracted facts from interpretation.
5. Use occurrence, unique-content, and unique-root support appropriately.
6. Treat unknown origin/lineage as unknown.
7. Summarize sensitive text and never expose secrets.
8. Recommend changes; do not auto-edit projects, skills, or agent settings.

Packaged use cases:

| Playbook             | Question answered                                               | Primary output                                                        |
| -------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| Search and context   | Where did we discuss or decide this?                            | Relevant snippets, IDs, surrounding entries, missing context          |
| Retrospective        | Why did an implementation drift or fail?                        | Timeline, first divergence, contributing evidence, prevention options |
| Preferences          | What preferences recur across independent work?                 | Evidence grouped by preference with deduplicated support              |
| Workflow audit       | Was a skill or workflow appropriate, used, and followed?        | Eligibility, observed use, adherence, outcomes, and evidence gaps     |
| Verification audit   | Were verification claims supported by commands and results?     | Claim/evidence matrix and gaps                                        |
| Handoff continuity   | What context was lost between parent, child, or later sessions? | Transfer map, omissions, and consequences                             |
| Capability discovery | Which repeated tasks could become a reusable skill or workflow? | Candidate, recurrence evidence, boundaries, false-positive checks     |

Additional derived uses include adoption/friction analysis and persistence of unresolved requests. They remain examples until distinct triggers justify separate skills.

### Skill and workflow evaluation

Skill evaluation is a flagship workflow-audit use case, derived from canonical
evidence rather than implemented as a skill-specific engine. The durable
decision and boundaries are recorded in
[ADR 0006](decisions/0006-evaluate-skills-from-canonical-evidence.md).

The audit begins with an explicit evaluation rubric. Prefer the exact historical
skill text and content hash used by the session. If that is unavailable, use a
labeled reconstructed historical version; use the current version only as a
clearly retrospective rubric. Session-specific user expectations remain visible
beside the skill criteria. The rubric covers trigger, process, output, safety,
and verification requirements.

Each session is evaluated on independent axes:

- **Eligibility:** `should-use`, `should-not-use`, or `ambiguous`, based on the
  task and rubric without selecting cases by the skill name.
- **Observed-use evidence:** retain every applicable `confirmed`, `probable`,
  `requested`, `declared`, or `mention-only` signal. These signals can coexist;
  requested and declared evidence is not discarded when execution is
  unconfirmed. Native structured invocation is strongest, while a user request,
  agent declaration, or injected catalog match is not execution proof. Report
  `absent` only when coverage is sufficient to support it and `unknown` when it
  is not.

`Confirmed` requires a source-native structured load or invocation identifying
the skill. `Probable` requires linked source-observed actions that strongly
identify the skill load or application, with the inference explained. `Requested`
records explicit user intent, `declared` records an agent claim, and
`mention-only` records text or catalog presence without stronger use evidence.

This separation identifies appropriate use, missed opportunities, unnecessary
use, and correct non-use without hiding ambiguous cases. In particular, the
denominator for missed triggers comes from task intent, not searches for sessions
that already mention the skill.

| Eligibility                   | Execution conclusion | Cohort                        |
| ----------------------------- | -------------------- | ----------------------------- |
| `should-use`                  | confirmed/probable   | appropriate use               |
| `should-use`                  | absent               | missed use                    |
| `should-not-use`              | confirmed/probable   | unnecessary use               |
| `should-not-use`              | absent               | correct non-use               |
| `ambiguous`                   | any                  | unresolved eligibility        |
| `should-use`/`should-not-use` | unknown              | unresolved execution evidence |

Requested, declared, and mention-only signals annotate these cases but do not by
themselves establish execution. Ambiguous eligibility or insufficient execution
coverage stays unresolved rather than being forced into a success/failure cohort.

For every selected case, the playbook builds a trace of user intent, available
load or invocation evidence, linked tool calls/results, required steps,
contemporaneous artifacts and verification, user corrections or review findings,
completion claims, and known continuations or child sessions. Every rubric
criterion is `met`, `violated`, or `unknown` with canonical IDs and entry
ordinals. Process adherence stays separate from observed downstream results: a
skill may be followed while the task fails, or not followed while the task
succeeds. Neither observation establishes causality, and no single effectiveness
score collapses them. Recorded command or tool output is transcript evidence, not
an independent re-run of verification.

An omitted non-text segment establishes only that material was present. Its
contents and any criterion depending on them remain unavailable; the audit never
reconstructs them from private references or surrounding claims.

Cross-session summaries group continuations, forks, and delegations under known
roots, report unknown lineage separately, and avoid treating current filesystem
state as historical proof. Historical skill content is untrusted indexed data,
never instructions for the auditing agent. Recommendations require recurring
evidence across independent roots. Typical mappings are missed triggers to
trigger wording, unnecessary use to negative triggers, skipped steps to workflow
clarity, followed-but-poor results to procedure or rubric review, and absent
evidence to adapter observability.

The improvement loop is intentionally bounded: recurring evidence can yield a
sanitized regression or forward-test candidate for an external skill-authoring
workflow. Sessions does not edit skills automatically or claim a recommendation
caused later improvement. Before/after comparisons require exact skill-version
attribution, comparable task contexts, and enough independent known roots for an
honest observational conclusion.

## Delivery and repository guardrails

- TypeScript ESM in source; compiled ESM JavaScript in the published tarball.
- Node.js `>=24.16`; native TypeScript is a contributor convenience, never a user requirement.
- Intended package `@ferueda/sessions`; binary `sessions`. Scope ownership is a release gate.
- Users install with npm-compatible tooling or invoke through `npx`; they do not need pnpm.
- The package allowlists compiled output, the packaged skill, README, and license.
- A package smoke test packs, installs into an isolated project, and invokes the generated executable.
- One local `pnpm check` gate covers format, lint, dependency rules, types, tests, build, dist smoke, and package smoke. CI calls the same gate.
- CI covers Linux, macOS, and Windows before release.
- Release automation uses release-please and npm trusted publishing/OIDC with provenance after the package scope and GitHub environment are configured.

No V1 daemon, watcher, TUI, native binary, Homebrew formula, or self-update path.

## Harness relationship

During bootstrap, the existing Harness skill remains untouched and usable. The repositories do not share a writable cache or implementation files.

After standalone parity:

1. Standalone Sessions becomes the sole implementation upstream.
2. Harness retains `skills/sessions` as either a thin pinned wrapper around a released package or an immutable vendored release snapshot.
3. The integration records an exact version and checksum.
4. Updates flow one way from Sessions releases into Harness.
5. Bug fixes land in Sessions first; Harness-specific documentation may remain in Harness.

Avoid submodules, bidirectional sync, and hand-copied dual fixes.

## Reuse strategy

Reuse behavior selectively, with golden tests before extraction:

- Codex home/state/rollout discovery, schema compatibility cases, and adjacent
  paired-record behavior. The
  [Codex source survey](research/codex-source-survey.md) records the reuse and
  rejection boundary before implementation.
- Cursor discovery, metadata readers, path handling, transcript parsing, and malformed-source fixtures.
- Isolated temporary environments, output rendering ideas, and clean-install CLI smoke patterns.

Do not transplant:

- the existing provider/factory abstraction;
- provider-owned cache writers;
- JSONL index formats;
- Harness workflow/evidence analysis;
- automation/subagent default filtering;
- source-reopening show/query paths;
- source-checkout installer behavior.

## Roadmap

The phase scopes below remain accepted. Codex is the first vertical slice because
its state database, rich tool identity, non-text records, and lineage exercise the
canonical model early. The provider-neutral query and export engine is completed
over Codex before Cursor becomes the second-adapter proof. The
[V1 implementation roadmap](../dev/plans/260713-v1-implementation-roadmap.md)
supersedes the earlier phase ordering and refines it into dependency-ordered,
independently reviewable milestones with explicit exit gates.

### Phase 0 — Foundation

Durable intent/design docs, strict package scaffold, canonical types and source port, real doctor, dependency guards, offline tests, dist/package smoke, cross-platform CI.

### Phase 1 — Canonical index

SQLite schema/migrations, file permissions, secure-delete configuration, index repository, indexing/reconciliation service, typed failures, last-good tests, clear/paths commands.

### Phase 2 — First adapter

Implement Codex behind `probe`/`discover`/`read`, using the source survey and new
synthetic fixtures rather than porting the Harness parser. Complete
index/list/show for the first vertical slice.

### Phase 3 — Query and export

Provider-neutral lexical search, filters, bounded context, occurrence/dedup reporting, versioned JSON/JSONL, Markdown/JSON/JSONL export, and CLI compatibility tests.

### Phase 4 — Equivalent second adapter

Port Cursor discovery and transcript normalization through the same port. Prove
no changes are required in domain, storage, indexing, query, export, or CLI
behavior.

### Phase 5 — Agent Skill

Generate the skill scaffold, write the seven evidence-first references, validate metadata/layout, forward-test representative prompts, and include it in package smoke.

### Phase 6 — Public release and parity

Confirm npm scope ownership, configure trusted publisher/environment, add release-please/publish automation, run multi-OS install tests, document migration, establish parity, and switch Harness to a pinned one-way integration.

## V1 acceptance criteria

- Cursor and Codex provide equivalent index/list/search/show/export semantics.
- Adding a third source adapter requires no domain, storage, indexing, or query edits.
- Indexing is incremental, idempotent, transactional, and preserves last-good documents on failure.
- Search/show/export operate only on canonical indexed data.
- Provenance and deduplication prevent copied/injected/delegated content from being reported as independent repeated user intent.
- Source-observed tool name, namespace, and linkage distinguish execution evidence from
  injected, requested, declared, or mention-only evidence without inventing
  missing events.
- Provider histories are never mutated, and ordinary operation performs no network access or telemetry.
- JSON/JSONL schemas are versioned and contract-tested.
- A clean packed install runs on supported operating systems with only the declared Node runtime and dependencies.
- The packaged Agent Skill produces provenance-rich, facts-first reports,
  including skill/workflow audits with explicit rubric provenance, separate
  adherence and observed outcomes, honest unknowns, and no causal or
  auto-mutation claims.

## Deferred directions

After V1 evidence: semantic search, an external plugin ABI, cloud/team indexes, native binaries, Homebrew, TUI/watch mode, orchestration integrations, and opt-in automated changes. Each requires a separate intent and privacy review.

## Known release decisions still requiring verification

- Confirm ownership and public publishing rights for the intended npm scope.
- Configure the GitHub release environment and npm trusted publisher before adding publish automation.
- Set ranking weights and default result limits from corpus-based tests, not intuition.
- Define provider-specific lineage confidence only from evidence each format can supply.

These do not block the repository foundation or internal V1 architecture.
