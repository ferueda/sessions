# Implementation plans

This directory holds the repository's active implementation plans.

- One plan per independently reviewable change.
- Plans describe outcomes, boundaries, exact change areas, and verification.
- Keep plans aligned with the current codebase; update them when scope changes.
- Remove completed plans. Git history remains the archive.

Program roadmap: [Sessions V1 implementation roadmap](260713-v1-implementation-roadmap.md).

Active storage-hardening plans, in execution order:

1. [Deletion and physical compaction contract](260714-deletion-compaction-contract.md)
2. [Expose and repair orphaned canonical content](260714-orphan-observability-repair.md)

Land the compact-content implementation before beginning compaction, then
reconcile the compaction plan with the resulting schema. Implement orphan repair
only after the compaction lease extension has landed and its plan has been
reconciled with the resulting schema and lease contracts.

Resume M7 after the storage-hardening sequence is complete.
