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
   make exact FTS verification memory-bounded, partition oversized terms, page
   only orphan candidates, and gate any compact-proof optimization separately.
3. [Verified bounded session reads](260723-verified-bounded-session-reads.md) —
   stream complete validation and the existing public-document digest while
   retaining only the requested bounded `show` or `export` selection.
