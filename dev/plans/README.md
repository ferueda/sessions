# Implementation plans

This directory holds the repository's active implementation plans.

- One plan per independently reviewable change.
- Plans describe outcomes, boundaries, exact change areas, and verification.
- Keep plans aligned with the current codebase; update them when scope changes.
- Remove completed plans. Git history remains the archive.

The durable product roadmap lives in the
[architecture memo](../../docs/architecture-memo.md#post-v1-roadmap).

## Active executor plans

Implement and close these cross-cutting performance plans independently:

1. [Certify crash-safe index generations](260721-certified-index-recovery.md)
   follows the completed bounded incremental work and can now certify the final
   batch mutation surface once. It adds an exact transactional recovery receipt
   and retains full validation as the fail-closed fallback.
2. [Streamline provider discovery I/O](260721-streamlined-provider-discovery.md)
   is independent of storage and may be scheduled separately. It removes Codex
   edge N+1 reads, one redundant snapshot byte pass, and serial Cursor leaf
   inventory work without changing provider evidence.

These maintenance plans do not reorder the product roadmap. Digest-guarded
coordinate reads remain the next product milestone to shape; later product
milestones still wait for their predecessor's contract and acceptance evidence.
