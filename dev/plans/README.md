# Implementation plans

This directory holds the repository's active implementation plans.

- One plan per independently reviewable change.
- Plans describe outcomes, boundaries, exact change areas, and verification.
- Keep plans aligned with the current codebase; update them when scope changes.
- Remove completed plans. Git history remains the archive.

Program roadmap: [Sessions V1 implementation roadmap](260713-v1-implementation-roadmap.md).

Active executor plan:

- [Expose and repair orphaned canonical content](260714-orphan-observability-repair.md)
  is third in the storage-hardening sequence. Implement it only after the
  compact-content baseline and compaction lease extension have landed and this
  plan has been reconciled with their resulting schema and lease contracts.

Resume M7 after the storage-hardening sequence is complete.
