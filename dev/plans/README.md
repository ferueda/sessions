# Implementation plans

This directory holds the repository's active implementation plans.

- One plan per independently reviewable change.
- Plans describe outcomes, boundaries, exact change areas, and verification.
- Keep plans aligned with the current codebase; update them when scope changes.
- Remove completed plans. Git history remains the archive.

Program roadmap: [Sessions V1 implementation roadmap](260713-v1-implementation-roadmap.md).

Active executor plan:

- [Measure routine indexing before optimizing it](260716-index-timing-baseline.md)

M10 capture truth, all-tracked reconciliation, and bounded source-change
recovery are complete. This plan adds indexing instrumentation and establishes
the correctness/timing baseline. A separately reviewed optimization follows
only after the baseline identifies its owner. M11 then proves Cursor
equivalence. Markdown presentation remains deferred beyond V1.
