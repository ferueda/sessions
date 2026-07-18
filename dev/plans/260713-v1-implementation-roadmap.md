# Sessions V1 roadmap

- Status: active
- Last updated: 2026-07-18

## Goal

Complete standalone Sessions V1: an installable local CLI and Agent Skill that
retain and analyze Cursor and Codex histories through one provider-neutral,
privacy-preserving evidence model.

The [project intent](../../docs/project-intent.md),
[architecture](../../docs/architecture-memo.md),
[privacy contract](../../docs/privacy.md), and
[CLI contract](../../docs/reference/cli-contract.md) remain authoritative.
Completed implementation detail stays available in Git history and the
[architecture decisions](../../docs/decisions/README.md).

## Current state

M0 through M12 are complete.

Sessions now provides:

- a compiled Node CLI distributed through npm;
- passive Cursor and Codex adapters;
- explicit incremental indexing into a durable local SQLite library;
- last-good snapshot retention and honest capture-scope reporting;
- provider-neutral list, search, entries, show, and export behavior;
- bounded human, JSON, and JSONL output;
- provenance, lineage, tool-call/result linkage, and deduplicated support;
- scoped deletion, orphan repair, page compaction, and safe whole-library clear;
- a packaged Agent Skill with evidence-first analysis playbooks;
- qualified cross-platform releases through GitHub and npm trusted publishing.

`0.1.0` established the supported data and CLI compatibility baseline. `0.1.1`
verified the routine release and recovery path. Markdown output remains deferred;
JSON and JSONL are the portable V1 formats.

## Completed milestones

| Milestone | Outcome                                                                             |
| --------- | ----------------------------------------------------------------------------------- |
| M0–M4     | Repository foundation, contracts, SQLite lifecycle, canonical storage, and indexing |
| M5        | Codex adapter and first end-to-end source slice                                     |
| M6        | Provider-neutral search and evidence semantics                                      |
| M7        | Stable JSON/JSONL query and export contracts                                        |
| M8        | Agent-efficient retrieval primitives                                                |
| M9        | Packaged Sessions Agent Skill and onboarding                                        |
| M10       | Capture-scope truth, retry, and routine-index performance                           |
| M11a      | Safe changed-read capture workspace                                                 |
| M11b      | Cursor adapter with equivalent rich evidence                                        |
| M11c      | Reduced Cursor JSONL fallback without rich-evidence downgrade                       |
| M12       | Public release qualification, trusted publishing, and supported npm releases        |

## M13 — Establish parity, cut Harness over, and close V1

Outcome: standalone Sessions becomes the sole general implementation, while
Harness keeps a thin, pinned Sessions skill entry and its Harness-specific
analysis guidance.

### 1. Standalone acceptance

- Compare Cursor and Codex through the same index, list, search, entries, show,
  and export outcome matrix.
- Compare standalone Sessions with the legacy Harness tool at the user-outcome
  level. Legacy command names, cache layout, automation filters, and
  Harness-specific presentation are not parity requirements.
- Run privacy-safe live dogfood checks against authorized local Cursor and Codex
  data. Report aggregate results only.
- Use a synthetic third adapter to prove that adding a provider requires no
  domain, storage, indexing, query, export, or CLI semantic changes.
- Confirm the released CLI and matching Agent Skill satisfy the V1 acceptance
  matrix.

### 2. Harness cutover

- Keep `harness/skills/sessions` as the user-facing Harness entry.
- Pin an exact published `@ferueda/sessions` version and integrity.
- Keep useful Harness-specific audit guidance.
- Remove duplicated general indexing/query implementation only after the pinned
  wrapper passes install, doctor, representative query, and rollback smokes.
- Keep ownership one-way: general fixes land in Sessions, then flow to Harness
  through a reviewed version bump.
- Do not share or migrate the legacy Harness cache. Users create the standalone
  durable library through explicit indexing.

### 3. V1 closure

- Run the complete acceptance matrix below.
- Publish and verify the release used by the final Harness integration.
- Update public and contributor docs to describe the finished V1 state.
- Remove this completed program roadmap from `dev/plans/`; Git history remains
  the archive.

### Exit gate

- Cursor and Codex pass equivalent provider-neutral workflows.
- The synthetic third adapter passes without core semantic changes.
- Provider files remain byte-identical during authorized live checks.
- Canonical digests, ordering, provenance, lineage, support counts, failures,
  and capture scope remain correct.
- Packed CLI and matching skill install without a source checkout.
- The pinned Harness wrapper and rollback path pass.
- `pnpm check` and the repository review workflow pass for each implementation
  change.

## Execution order

M13 is cross-repository and should use one reviewed plan with independently
reviewable changes:

1. Sessions parity and acceptance evidence.
2. Harness pinned-consumer cutover.
3. Final Sessions release and V1 documentation closure.

Do not remove the Harness implementation before the pinned replacement and
rollback route work. Do not combine post-V1 features with the cutover.

## After V1

Preferred evidence primitives:

- related-session traversal;
- literal metadata discovery;
- multi-session JSON/JSONL bundles with reproducibility manifests;
- exact named-unit facets;
- deterministic comparisons and timelines;
- machine-readable capability discovery;
- archive import/restore designed as a separate contract.

Nearer candidates still require measurement:

- adjacent-token phrase search;
- smaller titles in search and entries output;
- interned provider locator strings.

Semantic relevance, causality, success/failure, drift, preferences, and workflow
recommendations stay in the Agent Skill. Semantic search, public adapter ABI,
cloud/team indexes, daemon/watch mode, TUI, native binaries, Homebrew,
cross-machine sync, raw provider backup, destination-provider delivery, and
automatic project edits require separate post-V1 design and privacy review.
