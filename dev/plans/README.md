# Implementation plans

This directory holds the repository's active implementation plans.

- One plan per independently reviewable change.
- Plans describe outcomes, boundaries, exact change areas, and verification.
- Keep plans aligned with the current codebase; update them when scope changes.
- Remove completed plans. Git history remains the archive.

Program roadmap: [Sessions V1 implementation roadmap](260713-v1-implementation-roadmap.md).

Active storage-hardening plan:

- [Expose and repair orphaned canonical content](260714-orphan-observability-repair.md)

Deletion and physical compaction are complete. Reconcile the orphan-repair plan
with the landed schema, page-reclamation health, and `compact` lease contract
before implementation.

Resume M7 after the storage-hardening sequence is complete.
