# Project intent

- Status: accepted product baseline
- Last updated: 2026-07-14

## Purpose

Sessions is a local-first command-line tool and packaged Agent Skill for finding, inspecting, and learning from AI coding-agent session history.

It turns provider-specific histories into one faithful, queryable local index so people and agents can recover context, audit outcomes, understand recurring work, and improve future collaboration without uploading transcripts.

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

V1 supports Cursor and Codex histories with equivalent index, list, search, show, and export behavior. Indexing is incremental, idempotent, transactional, and preserves the last good indexed session when a refresh fails. Human-readable output works interactively; versioned JSON and JSONL work for scripts and agents.

The first repository scaffold is intentionally smaller: help, version, doctor, internal canonical contracts, docs, packaging, and verification guardrails. Planned commands are not represented as shipped until implemented.

## Non-goals for V1

- Cloud sync, team storage, accounts, or telemetry.
- Mutating provider histories.
- A daemon, file watcher, TUI, or self-updater.
- Semantic/vector search.
- A public third-party plugin ABI.
- Workflow orchestration or automatic edits based on session analysis.
- Harness-specific workflow analysis, automation classification, or default filtering.
- Perfect reconstruction when a provider omits or rewrites source information.

## Hard invariants

- Source histories are read-only.
- Indexing begins only through an explicit user command.
- Normalized content remains local; core operation requires no network access.
- Domain, indexing, storage, and query code contain no provider branches.
- Adapters discover and normalize source data; they do not own persistence, querying, rendering, or business policy.
- Show and export read the canonical index, not mutable provider files.
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
- Structured output is versioned. Stdout carries requested data; stderr carries diagnostics.
- Empty results are successful. Usage errors and operational failures have different exit codes.
- Published users execute compiled JavaScript and do not need pnpm or TypeScript.
- Durable docs, examples, tests, and fixtures contain no private downstream-repository assumptions.

## Unsafe assumptions

- A provider's on-disk format, location, or schema is stable.
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
