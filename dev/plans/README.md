# Implementation plans

This directory holds the repository's active implementation plans.

- One executor plan per independently reviewable change.
- Plans describe outcomes, boundaries, exact change areas, and verification.
- Keep plans aligned with the current codebase; update them when scope changes.
- Remove completed plans. Git history remains the archive.

The durable product roadmap lives in the
[architecture memo](../../docs/architecture-memo.md#post-v1-roadmap).

## Active program plans

Each program is ordered internally. Promote one numbered delivery slice at a
time into its own executor plan and independently reviewable change;
evidence-gated slices receive an executor plan only after their gate passes.

1. [Indexing hot paths](260723-indexing-hot-paths.md) — measure discovery and
   replacement work, remove avoidable provider lookup/serialization and
   statement-per-content costs, then gate deeper transaction or WAL changes.
2. [Doctor and maintenance hot paths](260723-doctor-maintenance-hot-paths.md) —
   record the rejected document-interval gate, page only orphan candidates, and
   keep compact-proof work separately gated.
3. [Single-pass doctor FTS feasibility](260723-doctor-single-pass-fts-feasibility.md) —
   evaluate an exact term-ordered alternative without repeated
   actual-vocabulary scans; gate any production refactor on corruption parity,
   memory-only state, compatible ordering, and measured scaling.
4. [Verified bounded session reads](260723-verified-bounded-session-reads.md) —
   stream complete validation and the existing public-document digest while
   retaining only the requested bounded `show` or `export` selection.
