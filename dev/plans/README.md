# Implementation plans

This directory holds the repository's active implementation plans.

- One plan per independently reviewable change.
- Plans describe outcomes, boundaries, exact change areas, and verification.
- Keep plans aligned with the current codebase; update them when scope changes.
- Remove completed plans. Git history remains the archive.

Program roadmap: [Sessions V1 implementation roadmap](260713-v1-implementation-roadmap.md).

Active storage-hardening plans, in execution order:

1. [Compact collision-safe canonical content storage](260714-compact-content-storage.md)
2. [Deletion and physical compaction contract](260714-deletion-compaction-contract.md)

Land and implement the compact-content baseline before beginning compaction.
Resume M7 after the accepted storage-hardening sequence.
