# Project intent

- Status: accepted product baseline
- Last updated: 2026-07-22

## Purpose

Sessions is a local-first command-line tool and packaged Agent Skill for retaining, finding, inspecting, and learning from AI coding-agent session history.

It turns provider-specific histories into one faithful, queryable local library so people and agents can preserve normalized sessions beyond provider retention, recover context, audit outcomes, understand recurring work, and improve future collaboration without uploading transcripts.

## Audience

- Individual developers using one or more supported coding agents.
- Agent authors building evidence-backed retrospectives, handoffs, and skill or
  workflow audits.
- Contributors adding source adapters without changing indexing or query behavior.

## What we optimize for

1. Transcript fidelity and traceable provenance.
2. Local privacy and explicit user control.
3. Provider-neutral behavior across supported sources.
4. Predictable scripting and Agent Skill use.
5. Easy installation without a source checkout or contributor toolchain.
6. An architecture where a new adapter does not modify domain, storage, or query logic.

## V1 outcome

V1 is complete in `0.2.0`. It supports Cursor and Codex histories with equivalent
index, list, search, show, and export behavior. Explicit indexing creates a
durable normalized local copy, is incremental, idempotent, and transactional,
and preserves the latest successful snapshot when refresh fails or a complete
later scan no longer observes the provider session. Human-readable output works
interactively, while versioned JSON and JSONL support scripts, agents, and
portable historical context. Markdown presentation remains post-V1 work.

## Post-V1 direction

Sessions now makes batch selection coherent through atomic, transcript-free
revision manifests and conditionally hydrates exact entries or bounded ranges
only when the caller's expected document digest still matches. The next ordered
work is provider-neutral related-session traversal, then an explicit
privacy-safe local project-context projection. Sessions remains the local
evidence layer that records what was retained and where. The Agent Skill and
other consumers own meaning, causality, outcomes, and recommendations.

Historical revision pinning or archives, canonical schema and coverage
expansion, and chunked or streamed full export remain evidence-gated. Each must
show a real need and pass a separate privacy and contract review before entering
an implementation plan.

## Non-goals for V1

- Cloud sync, team storage, accounts, or telemetry.
- Mutating provider histories.
- A daemon, file watcher, TUI, or self-updater.
- Semantic/vector search.
- A public third-party plugin ABI.
- Workflow orchestration or automatic edits based on session analysis.
- Delivering exported context into a provider, creating destination conversations,
  or managing destination context limits.
- Raw provider backups, attachment/media archives, or immutable history of every
  observed provider revision. Permission-restricted, lease-scoped working copies
  needed to read an active provider WAL are transient execution artifacts, not a
  restore/archive feature.
- Protection against local disk loss, malware, or another process running as the
  same user.
- Harness-specific workflow analysis, automation classification, or default filtering.
- Perfect reconstruction when a provider omits or rewrites source information.

## Hard invariants

- Source histories are read-only.
- Indexing begins only through an explicit user command.
- Registered providers are optional by default. Provider absence does not make
  another provider unusable; explicitly selected or installed-but-unreadable
  providers still fail honestly.
- A successful index stores the latest normalized canonical snapshot as durable
  Sessions-owned user data until explicit Sessions deletion.
- A session absent from a complete source scan is marked no longer observed; its
  last successful canonical snapshot is not deleted. Unavailable, unreadable, or
  incomplete discovery never proves source absence.
- Canonical session data and rebuildable search projections have separate
  lifecycles even when they share one SQLite database. Rebuilding search state
  never deletes retained sessions.
- Normalized content remains local; core operation requires no network access.
- Domain, indexing, storage, and query code contain no provider branches.
- Adapters discover and normalize source data; they do not own persistence, querying, rendering, or business policy.
- Show and export read the canonical library, not mutable provider files.
- Provenance distinguishes human, injected, delegated, replayed/copied, model, tool, system, and unknown content when evidence allows.
- Unsupported non-text content is an explicit omission, never generated
  searchable placeholder text or retained media bytes/references.
- Repeated evidence reports occurrence, unique-content, and unique-root counts rather than silently inflating recurrence.
- A skill name, injected catalog, user request, or agent declaration is not
  reported as an invocation without stronger source-observed execution evidence.
- Skill and workflow audits separate eligibility, observed use, process
  adherence, and observed outcomes; unknowns remain unknown and association is
  not reported as causation.
- Failed refreshes never replace a last-good indexed session with partial data.
- No automatic TTL, pruning, or provider-deletion propagation removes retained
  canonical content.
- Portable exports never expose diagnostic source locators or local paths by
  default and frame transcript instructions as untrusted historical data.
- Structured output is versioned. Stdout carries requested data; stderr carries diagnostics.
- A successful revision manifest is one complete ordered cohort from one
  retained-library snapshot; bounds fail rather than truncate or page it.
- Empty results are successful. Usage errors and operational failures have different exit codes.
- Published users execute compiled JavaScript and do not need pnpm or TypeScript.
- Durable docs, examples, tests, and fixtures contain no private downstream-repository assumptions.

## Unsafe assumptions

- A provider's on-disk format, location, or schema is stable.
- A provider session that disappears was intentionally deleted by the user.
- A normalized retained snapshot is an exact raw-provider backup or preserves
  every historical revision.
- A local application-data database is itself a backup against disk loss.
- Every apparent user message was authored directly by the user.
- A mentioned or declared skill was actually invoked.
- An observed task result was caused by a skill that appeared in the session.
- Repeated text means repeated independent intent.
- Current filesystem state proves what existed or passed during a historical
  session.
- Timestamps, titles, workspace paths, or lineage are always present.
- SQLite was built with FTS5 merely because the runtime exposes SQLite.
- File deletion or SQLite secure-delete guarantees forensic erasure.
- The npm scope, release environment, or trusted publisher is configured before it is verified.

## Decision authority

This document owns purpose, goals, non-goals, and hard invariants. The accepted target design lives in [the architecture memo](architecture-memo.md). Normative privacy and command semantics live in their focused contracts. Architecture decision records explain individual choices and may supersede details without weakening these invariants.
