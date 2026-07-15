# Implementation plans

This directory holds the repository's active implementation plans.

- One plan per independently reviewable change.
- Plans describe outcomes, boundaries, exact change areas, and verification.
- Keep plans aligned with the current codebase; update them when scope changes.
- Remove completed plans. Git history remains the archive.

Program roadmap: [Sessions V1 implementation roadmap](260713-v1-implementation-roadmap.md).

Active executor plan:

- [Compact collision-safe canonical content storage](260714-compact-content-storage.md)

Land the baseline-schema plan before compaction or orphan-maintenance plans that
extend the same schema or writer-lease contracts. Resume M7 after the accepted
storage-hardening sequence.
