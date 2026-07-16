# Implementation plans

This directory holds the repository's active implementation plans.

- One plan per independently reviewable change.
- Plans describe outcomes, boundaries, exact change areas, and verification.
- Keep plans aligned with the current codebase; update them when scope changes.
- Remove completed plans. Git history remains the archive.

Program roadmap: [Sessions V1 implementation roadmap](260713-v1-implementation-roadmap.md).

M10 capture truth, all-tracked reconciliation, and bounded source-change
recovery are complete. Indexing instrumentation and its synthetic/real
correctness baseline are also complete; the baseline selected writer-open
validation as the next owner. There is no active executor plan. A separately
reviewed recovery-safe writer-open optimization completes M10 before M11 proves
Cursor equivalence. Markdown presentation remains deferred beyond V1.
