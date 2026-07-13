# Sessions V1 implementation roadmap

- Status: active program roadmap
- Date: 2026-07-13
- Foundation baseline: PR #1, merged as `601f924`

## Goal

Deliver the accepted standalone Sessions V1: an installable, local-first CLI and
packaged Agent Skill that index Cursor and Codex histories through passive source
adapters, persist one canonical SQLite/FTS5 representation, and expose equivalent
list, search, show, and export semantics without depending on Harness at runtime.

This roadmap sequences the full program. It is not permission to implement every
milestone in one change. Each numbered milestone becomes a scoped implementation
plan and independently reviewable pull request before work starts. The accepted
[architecture memo](../../docs/architecture-memo.md),
[project intent](../../docs/project-intent.md),
[privacy contract](../../docs/privacy.md), and
[CLI contract](../../docs/reference/cli-contract.md) remain authoritative.

## Current state

Phase 0 is complete. The repository currently has:

- compiled TypeScript/ESM package delivery with a `sessions` binary;
- strict dependency, format, lint, type, test, build, dist, and packed-install
  gates behind `pnpm check`;
- cross-platform CI and dependency updates;
- provider-neutral session shapes and the initial `SessionSource` port;
- a real, read-only `doctor` command for Node and in-memory SQLite/FTS5;
- accepted architecture, privacy, CLI, adapter, and contributor contracts.

It does not yet have persistent state, migrations, a canonical repository,
indexing/reconciliation, Cursor or Codex adapters, list/search/show/export,
structured schemas for those commands, the packaged Agent Skill, release
automation, or the pinned Harness integration.

The current domain and source-port types are a foundation, not a frozen public
API. Milestone 1 hardens them before database or adapter code depends on them.

## Execution rules

1. One milestone, one scoped executor plan, one primary pull request. Split a
   milestone only when reviewability requires it; do not combine adjacent
   milestones to save process.
2. Run the plan reviewer for every non-trivial executor plan. Run `pnpm check`
   and the repository change-review workflow before merging implementation.
3. Keep generated help and user docs honest: add a command only when its complete
   path and contract tests work.
4. Use synthetic fixtures and temporary roots. Never commit personal transcripts,
   provider databases, machine paths, or secrets.
5. Runtime commands remain offline and telemetry-free. Provider inputs are opened
   read-only. Only explicit indexing creates or migrates persistent state.
6. Every state boundary proves success, malformed input, partial failure,
   interruption, and retry behavior at the highest stable test seam.
7. Any new production dependency needs a concrete runtime benefit, package-impact
   review, and an equivalent-dependency check. Native Node APIs remain preferred.
8. Update current-versus-planned docs in the same pull request as behavior.

## Dependency map

```mermaid
flowchart TD
  M0["M0 Foundation — complete"] --> M1["M1 Canonical contracts"]
  M1 --> M2["M2 State and SQLite lifecycle"]
  M2 --> M3["M3 Canonical repository"]
  M3 --> M4["M4 Indexing and reconciliation"]
  M4 --> M5["M5 Cursor vertical slice"]
  M5 --> M6["M6 Query and evidence engine"]
  M6 --> M7["M7 Export and CLI schemas"]
  M7 --> M8["M8 Codex parity"]
  M8 --> M9["M9 Packaged Agent Skill"]
  M9 --> M10["M10 Release qualification"]
  M10 --> M11["M11 Parity, Harness cutover, V1"]
```

This intentionally completes provider-neutral query/export behavior before the
second adapter. Codex then becomes the architecture proof: it must enter through
the existing source port without provider-specific changes to domain, storage,
indexing, query, or CLI semantics.

## Milestones

### M0 — Foundation (complete)

Outcome: honest pre-alpha repository, architecture baseline, executable doctor,
and robust local/CI gates.

Evidence: existing `src/`, `test/`, `.github/`, package scripts, contracts, and
the merged initial scaffold. The completed scaffold plan is removed from the
active plan directory; Git history remains its archive.

### M1 — Harden canonical contracts and source conformance

Outcome: one stable internal vocabulary that storage, indexing, and every adapter
can implement without provider cases.

Primary change areas:

- `src/domain/session.ts` and focused identity, content-hash, provenance, and
  lineage modules under `src/domain/`;
- `src/application/ports/session-source.ts` and typed source failures under
  `src/application/`;
- reusable adapter conformance helpers under `test/contracts/` and synthetic
  provider fixture builders under `test/fixtures/`.

Required decisions and behavior:

- Replace the single discovered-session locator with ordered input descriptors.
  Each input has an opaque diagnostic locator and fingerprint; the candidate has
  one aggregate fingerprint covering every input consumed by `read()`.
- Require adapters to verify candidate inputs while reading. A changed input is a
  typed `source-changed` failure, never a partially normalized document.
- Add typed unavailable, unreadable, malformed, source-changed, and unsupported-
  format failures with safe diagnostics that do not include transcript text.
- Let probe results expose sanitized resolved source roots for `sessions paths`;
  path resolution remains adapter-owned and never reads transcript content.
- Define and round-trip one escaped printable identity grammar for adapter kind,
  source instance, and opaque native ID before the value enters storage or JSON.
- Make content hashing core policy, not adapter policy. V1 uses versioned SHA-256
  over the exact UTF-8 canonical segment text; hash collisions never merge
  unequal text.
- Validate ordinals, relation targets, timestamps, actor/origin values, and
  deterministic ordering at the application boundary. Missing evidence maps to
  absent or `unknown`, never inference.
- Define one occurrence as one canonical content segment at one entry/segment
  ordinal. Exact equal text does not, by itself, prove copied/replayed origin.
- Keep the port internal. Do not add adapter discovery, plugin loading, or a
  public library export.

Exit gate:

- A synthetic source passes the shared conformance suite for non-mutating probes,
  deterministic discovery/read, complete fingerprint invalidation, source change
  during read, missing optional metadata, stable ordering, malformed inputs,
  unknown provenance, and generic adapter kinds.
- Identity and hash codecs have focused round-trip and adversarial-input tests.
- `pnpm check` passes.

### M2 — Add state paths, SQLite lifecycle, and privacy controls

Outcome: Sessions can explain and safely initialize its own rebuildable state,
without yet implementing repository behavior.

Primary change areas:

- `src/domain/index-state.ts`;
- `src/application/get-paths.ts` and an index-lifecycle port under
  `src/application/ports/`;
- `src/infrastructure/state/paths.ts`;
- `src/infrastructure/sqlite/database.ts`, `migrations.ts`, `permissions.ts`, and
  migration modules;
- `sessions paths`, composition wiring, and SQLite lifecycle integration tests.

Required decisions and behavior:

- Resolve a Sessions-specific platform cache directory: XDG cache on Linux,
  `Library/Caches` on macOS, and `LOCALAPPDATA` on Windows. The explicit
  `SESSIONS_CACHE_DIR` override selects the owned directory for tests and advanced
  use. Never reuse or auto-migrate the legacy Harness JSONL cache.
- `sessions paths [--format human|json]` initially reports only Sessions-owned
  index/state locations plus initialized state without creating directories or
  files. Registered adapters extend it with their own source roots in M5 and M8.
- Only explicit `sessions index` opens a writer that creates state or applies
  migrations. Read commands report missing or incompatible state with a concise
  remediation path; they do not silently initialize or rebuild it.
- Use ordered, checksummed, forward-only migrations. Apply each release migration
  transactionally, refuse a database from a newer schema, and leave a failed
  migration recoverable.
- Writer connections enable foreign keys, WAL, a bounded busy timeout, SQLite
  `secure_delete`, and FTS5 secure-delete when supported. Unsupported FTS secure
  deletion is reported honestly rather than treated as encryption.
- Create POSIX owned directories as `0700` and constrain database, WAL, and SHM
  files to `0600`; use the current user's profile-local state and platform ACLs
  on Windows.
- Extend doctor non-mutatively for resolved-path safety and compatibility. An
  uninitialized index is healthy with guidance, not an error.

Exit gate:

- Path-resolution tests cover supported operating systems, missing environment
  values, the explicit override, state-only output before adapters, and no state
  creation from `paths` or `doctor`.
- SQLite tests cover fresh create/reopen, ordered migrations, injected rollback,
  newer-version refusal, foreign keys, FTS5, pragmas, and effective POSIX modes.
- Tests prove lifecycle code never opens provider histories for writing.
- `pnpm check` passes on all CI operating systems.

### M3 — Implement the canonical repository and query-ready schema

Outcome: one provider-neutral repository can atomically persist and reconstruct a
complete canonical document while retaining the state needed for incremental
indexing, last-good behavior, recurrence, and future search.

Primary change areas:

- `src/application/ports/session-index.ts`;
- `src/application/validate-session.ts`;
- the initial canonical migration under `src/infrastructure/sqlite/migrations/`;
- `src/infrastructure/sqlite/sqlite-session-index.ts`;
- repository integration and round-trip fixtures under `test/infrastructure/`.

Initial schema responsibilities:

- migration metadata, source instances, index runs and run items;
- sessions and provider-neutral relations;
- ordered entries;
- unique content values keyed collision-safely by hash scheme, digest, and text;
- content occurrences retaining session, entry, segment ordinal, actor, origin,
  confidence, timestamp, and diagnostic source metadata;
- an external-content FTS5 table maintained as derived search state.

Repository behavior:

- Expose business values only—no SQL, FTS, Cursor, or Codex vocabulary in the
  application port.
- Retain last-good indexed fingerprint/version/document separately from the latest
  discovered fingerprint/version/error. A refresh failure marks an indexed
  session stale without replacing canonical content.
- Replace one session document and its FTS rows atomically. Rollback restores the
  complete previous document.
- Reconstruct list summaries and full canonical documents only from the index.
- Keep run diagnostics bounded by an explicit retention policy in the scoped
  plan; transcript content is not retained merely for diagnostics.
- Parameterize all SQL and preserve source-instance isolation when native IDs
  collide.

Exit gate:

- Exact canonical round-trip, atomic replacement, forced rollback, cascade/FTS
  consistency, collision safety, source-instance isolation, and last-good/stale
  state tests pass.
- A repository contract suite passes against SQLite without provider branches.
- `pnpm check` passes.

### M4 — Build indexing, reconciliation, maintenance, and writer safety

Outcome: a provider-neutral application service owns the complete indexing
lifecycle before any concrete provider is wired.

Primary change areas:

- `src/application/run-index.ts`, validation, reports, and operational errors;
- source-selection and index-lifecycle application values;
- `src/application/clear-index.ts`;
- state-aware SQLite diagnostics and writer coordination;
- fake-source/index integration tests.

Index sequence:

1. Resolve explicitly selected source instances and run their probes.
2. Start an inspectable run for one source instance.
3. Complete discovery, tracking whether iteration ended normally.
4. Compare identity, aggregate input fingerprint, and adapter version.
5. Skip unchanged candidates without calling `read()`.
6. Read and validate changed candidates, then atomically replace each session.
7. Reconcile unseen sessions only after a complete discovery for that exact
   source instance.
8. Finish with discovered, unchanged, updated, failed, removed, stale, and
   incomplete counts plus bounded item diagnostics.

Failure and concurrency policy:

- Failed reads preserve prior canonical rows and record staleness. A new failed
  candidate records diagnostics but no document.
- A thrown or incomplete discovery removes nothing. A complete later scan removes
  missing canonical documents; it retains non-content run evidence only.
- Two indexing writers cannot mutate the same index concurrently. The second
  exits with an operational diagnostic; a later run identifies and closes an
  interrupted predecessor safely.
- `sessions index clear` removes only the known Sessions database and sidecar
  files. Missing state is success. An active/locked index is refused; the cache
  root and provider files are never recursively deleted.
- State-aware doctor reports incompatible schema, unsafe modes, integrity/FTS
  failure, secure-delete support, and interrupted runs without mutating state or
  content timestamps.
- Do not expose `sessions index` in generated help until M5 registers a real
  source.

Exit gate:

- Fake sources prove unchanged skip, adapter-version invalidation, idempotence,
  discovery-order independence, last-good preservation, source-changed handling,
  incomplete-scan no-delete, complete-scan removal, interrupted-run recovery, and
  two arbitrary adapter kinds without engine edits.
- Clear/doctor tests cover absent state, only-owned-file deletion, locked refusal,
  stable structured reports, streams, and exit codes.
- `pnpm check` passes.

### M5 — Ship the Cursor vertical slice

Outcome: the first end-to-end user workflow indexes Cursor and serves list/show
from the canonical index.

Primary change areas:

- `src/adapters/cursor/source.ts`, `paths.ts`, `meta.ts`, `transcript.ts`,
  `normalize.ts`, and `fingerprint.ts`;
- Cursor synthetic fixtures, golden parser tests, and the shared source contract;
- application services for list/show;
- modular CLI commands/renderers and composition registration;
- a documented Cursor format-support matrix.

Required behavior:

- Selectively port proven path, metadata, transcript, and malformed-input behavior
  from the approved Harness baseline. Do not port its provider factory, JSONL
  cache, source-reopening queries, analysis, classifications, or automation
  filters.
- Open provider databases read-only and transcript files without write access.
  Cursor metadata inputs participate in the same complete candidate fingerprint
  as transcript inputs.
- Preserve injected blocks such as user information, instructions, and user query
  as separate canonical segments with evidence-backed provenance instead of
  stripping them. Do not make automation or subagent exclusions a default.
- Cover current message and tool-use records. Unknown optional records degrade
  according to the support matrix; structural corruption returns a typed failure.
- Register Cursor only in `src/bin/sessions.ts`. Expose working
  `index --source cursor`, provider-neutral `list`, and index-only `show` with
  bounded output and canonical IDs. Extend `sessions paths` with Cursor roots
  supplied by the adapter's probe result.

Exit gate:

- Cursor passes shared conformance and provider golden tests, including missing
  metadata, changing inputs, malformed records, stable ordering, and read-only
  operation.
- An end-to-end temporary-home test indexes, lists, and shows. Changing or deleting
  provider files after indexing cannot change list/show until another explicit
  index; a failed refresh preserves the prior result.
- The packed CLI can run the synthetic Cursor workflow.
- `pnpm check` passes on all CI operating systems.

### M6 — Add provider-neutral search and evidence semantics

Outcome: one query engine implements lexical retrieval, filters, context, lineage,
and honest recurrence measures over indexed data.

Primary change areas:

- query, pagination, and support-count values under `src/domain/`;
- list/search/show services and query ports under `src/application/`;
- `src/infrastructure/sqlite/sqlite-session-query.ts`;
- `sessions search`, shared filters, and query contract/corpus tests.

Required behavior:

- Public query values cover text, source/source instance, workspace, time bounds,
  actor, origin, exact identity, limit, and opaque continuation cursor. Raw FTS5
  syntax is never a public API; special characters are accepted as user text.
- Translate to parameterized FTS/SQL with deterministic ordering and stable
  pagination. Ranking, tokenizer settings, and bounded defaults are selected from
  a checked-in synthetic corpus representing prose, file paths, symbols, IDs,
  punctuation, and repeated content—not intuition.
- Search returns index-backed snippets and bounded surrounding entries. Empty
  results are success. List, search, and show share filter meanings.
- Resolve known lineage without recursion hazards. Cycles, missing ancestors, or
  unsupported relations remain unknown and never fabricate independent roots.
- Report occurrence count, unique-content count, unique-known-root count, and
  unknown-lineage support distinctly. Do not infer copied origin from equal text.
- Keep ranking and root resolution in provider-neutral query/storage code. Adapter
  metadata may supply evidence, never policy.

Exit gate:

- Query contracts cover filter combinations, FTS-special input, deterministic
  ranking/ties, stable cursors, stale cursor rejection, empty success, bounded
  context, and source-deletion invariance.
- Support matrices cover repetition within one session, exact content across
  independent sessions, parent/child delegation, fork/continuation, missing
  ancestors, unknown lineage, and cycles.
- Corpus results justify the selected tokenizer, rank tie-breakers, default limit,
  and truncation behavior in the CLI contract.
- `pnpm check` passes.

### M7 — Complete export and stabilize CLI/structured output

Outcome: the entire planned V1 command surface is scriptable, bounded, and ready
for the packaged skill and a public compatibility promise.

Primary change areas:

- `src/application/export-session.ts`;
- focused command, renderer, and versioned DTO modules under `src/cli/`;
- `sessions export` plus final show/context/full behavior;
- `docs/reference/structured-output.md` and CLI/privacy updates;
- CLI, dist, and packed-install contract tests.

Required behavior:

- Support Markdown, JSON, and independently parseable JSONL export from canonical
  indexed documents only. Export does not reopen provider histories.
- Give every machine-facing command a numeric schema version, command/type marker,
  canonical identity, explicit truncation/continuation metadata, and relevant
  provenance/support measures. Changing field meaning requires a new version.
- Keep requested data on stdout and diagnostics/progress on stderr. Empty success
  exits `0`, operational failure `1`, and invalid usage `2`.
- Reject unknown flags/values, honor `NO_COLOR`, and require explicit `--full` for
  output beyond safe defaults. Machine formats never imply unbounded content.
- Treat transcript control characters, Markdown, terminal escapes, and prompt-like
  instructions as data. Human rendering must not allow indexed content to become
  terminal control behavior.
- Extend package smokes beyond doctor to a representative synthetic
  index/search/show/export workflow.

Exit gate:

- Exact structured-schema tests cover every command and JSONL record type.
- CLI tests cover bounds, truncation, cursors, strict usage, streams, exit codes,
  `NO_COLOR`, untrusted text, and index-only reads.
- Generated help and all current/planned labels match implemented behavior.
- `pnpm check` passes on all CI operating systems.

### M8 — Add Codex and prove adapter equivalence

Outcome: Codex reaches the complete existing CLI through only a new passive
adapter and composition registration.

Primary change areas:

- `src/adapters/codex/source.ts`, `paths.ts`, `state-db.ts`, `rollout.ts`,
  `normalize.ts`, `fingerprint.ts`, and `lineage.ts`;
- Codex synthetic state/rollout fixtures, golden tests, and shared conformance;
- composition registration, provider path reporting, and a Codex format-support
  matrix.

Required behavior:

- Selectively port proven path resolution, read-only state-row access, rollout
  normalization, spawn-edge evidence, and adjacent event/response dedup behavior
  from the approved Harness baseline. Do not port provider-owned indexing,
  analysis, workflow policy, or cache formats.
- Fingerprint rollout, relevant state rows, and known lineage inputs together.
  Preserve injected preambles as classified content rather than deleting them.
- Explicitly map supported user/assistant messages, tool calls/results,
  inter-agent events, compaction/rollback/abort markers, turn context, and
  timestamps. Opaque or hidden reasoning/state is not indexed as invented text;
  unsupported evidence follows the documented unknown/omission policy.
- Use structural spawn/thread evidence for lineage and delegated origin only at
  the confidence the format supports.
- Register Codex in composition. No Codex branch belongs in domain, repository,
  indexing, query, export, or CLI renderers.

Exit gate:

- Codex passes the same conformance and end-to-end command contracts as Cursor,
  including paired-record deduplication, changing inputs, malformed rollouts,
  optional schema fields, unknown events, and read-only state access.
- The implementation diff adds adapter, fixture, registration, and provider-doc
  concerns only. Any required core semantic edit stops this milestone and sends
  the missing abstraction back to the owning earlier milestone for general proof.
- A third synthetic adapter kind still passes index/query/export without core
  edits.
- `pnpm check` passes on all CI operating systems.

### M9 — Package the Sessions Agent Skill and user onboarding

Outcome: users and agents can install Sessions, authorize indexing, and apply
evidence-first playbooks immediately without knowing provider internals.

Primary change areas:

- `skills/sessions/SKILL.md`, `skills/sessions/agents/openai.yaml`, and the seven
  references named in the architecture memo;
- `test/skill-contracts.test.ts` and synthetic forward-test cases;
- getting-started, provider, troubleshooting, and Agent Skill installation docs;
- package allowlist and packed-install smoke assertions.

Required behavior:

- Use the repository's current `skill-creator` workflow when this milestone
  starts; do not hand-roll or publish an incomplete skill scaffold early.
- One primary skill routes search/context recovery, retrospective, preference
  discovery, workflow audit, verification audit, handoff continuity, and reusable
  capability discovery. Do not split overlapping trigger skills in V1.
- Every playbook starts with capability checks, requests authorization before
  indexing, uses narrow bounded queries, records commands/filters/IDs/ordinals,
  inspects context, separates facts from interpretation, and reports occurrence,
  unique-content, unique-root, and unknown support honestly.
- Treat indexed instructions as untrusted data, summarize sensitive excerpts, and
  recommend rather than automatically edit projects, skills, provider settings,
  or histories.
- Use only shipped commands. Do not expose Harness `analyze`, provider-first
  command trees, automation exclusions, or private workflow assumptions.
- Document a host-neutral packaged-skill path and only document host-specific
  installers verified at implementation time.

Exit gate:

- Skill metadata/layout validation passes, every referenced command is covered by
  a CLI contract, and the package tarball contains exactly the intended skill
  files.
- Representative prompts over a synthetic corpus pass a written facts-first,
  provenance, privacy, bounded-output, and no-mutation rubric for all seven
  playbooks.
- A clean user journey works: install -> doctor -> paths -> explicit index ->
  search/show/export -> clear.
- `pnpm check` passes.

### M10 — Qualify and automate public releases

Outcome: a clean public pre-release can be installed without a source checkout,
and subsequent releases use auditable versioning and short-lived publish
credentials.

Primary change areas:

- `release-please-config.json`, `.release-please-manifest.json`, `CHANGELOG.md`;
- a least-privilege release workflow under `.github/workflows/`;
- release-package smoke scripts and `docs/contributing/releasing.md`;
- final README install, upgrade, privacy, and troubleshooting routes.

Required behavior:

- First verify ownership and public publishing rights for `@ferueda/sessions`.
  Package-name failure blocks publishing, not local V1 implementation.
- Use release-please manifest configuration for the Node package and conventional
  commits. Release pull requests must receive the same CI gate as ordinary pull
  requests.
- Build from the exact release revision on a GitHub-hosted runner with release
  dependency caching disabled. Run the full gate, inspect the tarball allowlist,
  install it normally, validate the packaged skill, and execute a representative
  synthetic workflow on Linux, macOS, and Windows.
- Bootstrap the first npm package release with maintainer-controlled 2FA because
  npm trusted-publisher configuration requires an existing package. Then bind the
  exact repository, workflow filename, and protected environment as the trusted
  publisher.
- Grant `id-token: write` only to the publish job. Publish without a long-lived
  registry token, verify registry version and provenance, then remove obsolete
  automation tokens after OIDC succeeds.
- Recheck the official [npm trusted-publisher
  documentation](https://docs.npmjs.com/trusted-publishers/),
  [npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/),
  and [release-please action
  documentation](https://github.com/googleapis/release-please-action) during
  implementation; external release requirements are not assumed permanently
  stable.

Exit gate:

- A release candidate installs through ordinary npm tooling and runs help,
  version, doctor, paths, synthetic index/search/show/export, clear, and packaged
  skill validation on every supported operating system.
- A dry run proves version/changelog/tag/package alignment and least-privilege job
  permissions. The first real publish proves registry metadata and provenance.
- User docs require neither pnpm nor TypeScript nor a Sessions source checkout.
- `pnpm check` passes from the release revision.

### M11 — Establish parity, retain the Harness skill, and close V1

Outcome: standalone Sessions becomes the only general implementation upstream;
Harness keeps its `skills/sessions` entry as a thin, pinned consumer.

Primary change areas:

- synthetic parity fixtures/matrix and migration guidance in this repository;
- a released standalone version and dogfood report for local Cursor/Codex data;
- a separate reviewed Harness change that pins the package version and integrity,
  keeps the skill entry, and removes only duplicated general engine internals
  after parity.

Required behavior:

- Compare canonical content, ordering, provenance, lineage, recurrence, and user
  outcomes. Legacy command spelling, JSONL cache layout, automation filtering, and
  Harness-specific analysis output are not parity requirements.
- Do not import or share the legacy cache. Migration is an explicit reindex into
  the standalone platform-cache path.
- Keep `skills/sessions` in Harness. Its launcher uses an exact standalone package
  version and lockfile integrity; Harness-specific audit guidance may remain, but
  general bug fixes land in Sessions first and flow one way through version bumps.
- Never leave Harness without a working Sessions path during cutover. Remove
  duplicated implementation only after wrapper smoke and rollback instructions
  pass against the pinned release.
- Run the full V1 acceptance matrix below, publish V1, then update current-state
  docs and remove this completed program roadmap from `dev/plans/`.

Exit gate:

- Cursor and Codex pass the same index/list/search/show/export contracts.
- A synthetic third adapter proves no domain, storage, indexing, query, export, or
  CLI semantic changes are needed.
- Standalone and the pinned Harness wrapper pass cache-separation, install,
  doctor, and representative query smokes.
- The released package and skill satisfy every V1 criterion in the architecture
  memo and privacy/CLI contracts.

## Release checkpoints

These are evidence checkpoints, not date commitments:

| Checkpoint             | Required evidence                                                     |
| ---------------------- | --------------------------------------------------------------------- |
| Foundation             | M0 complete; current pre-alpha repository                             |
| Internal alpha         | M1-M5; Cursor index/list/show vertical slice                          |
| Feature-complete alpha | M6-M7; Cursor search/evidence/export and stable schemas               |
| Beta                   | M8; Codex equivalence and third-adapter architecture proof            |
| Release candidate      | M9-M10; packaged skill, onboarding, install and publish qualification |
| V1                     | M11; parity, released package, and pinned one-way Harness integration |

Do not publish an alpha whose help advertises placeholder behavior. Do not call a
release beta until both adapters use the same complete engine. Do not call a
release V1 until the packaged skill and Harness continuity are proven.

## Program acceptance matrix

Every V1 release candidate must prove:

- **Architecture:** provider-neutral core; passive adapters; only composition
  knows concrete implementations; third-adapter proof passes.
- **Index integrity:** incremental, idempotent, transactional, single-writer,
  complete-scan reconciliation, adapter-version invalidation, and last-good
  preservation.
- **Evidence integrity:** faithful canonical content, explicit provenance
  confidence, index-only reads, separate occurrence/unique-content/unique-root
  measures, and honest unknown lineage.
- **Privacy:** explicit indexing, read-only provider access, no runtime network or
  telemetry, restrictive owned-state permissions, bounded diagnostic retention,
  honest deletion limitations, and only-owned-file clearing.
- **CLI:** consistent filters, stable identity, bounded defaults, deterministic
  pagination/ranking, versioned JSON/JSONL, strict usage, clean streams, and
  portable exit codes.
- **Delivery:** clean compiled install, allowlisted tarball, packaged skill,
  multi-OS full/smoke gates, release provenance, and no source-checkout runtime.
- **Adoption:** install-to-first-search guide, provider/troubleshooting reference,
  seven evidence-first playbooks, and no automatic user-project mutation.
- **Continuity:** no shared legacy cache, explicit reindex migration, retained
  Harness skill entry, exact pinned integration, and one-way ownership.

## Deferred beyond V1

Semantic/vector search, public adapter/plugin ABI, cloud or team indexes, daemon
or watch mode, TUI, native binaries, Homebrew, self-update, orchestration
integrations, automatic project edits, and multiple overlapping Sessions skills
remain out of scope. Each needs new intent, architecture, privacy, and delivery
review after V1 usage supplies evidence.
