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

1. [Bound routine incremental indexing work](260721-bounded-incremental-indexing.md)
   is next. It replaces per-session freshness and tracking transactions with
   fixed-size provider-neutral batches while preserving complete-discovery and
   exact-result semantics.
2. [Certify crash-safe index generations](260721-certified-index-recovery.md)
   follows plan 1 so it certifies the final batch mutation surface once. It adds
   an exact transactional recovery receipt and retains full validation as the
   fail-closed fallback.
3. [Streamline provider discovery I/O](260721-streamlined-provider-discovery.md)
   is independent of storage and may be scheduled separately after plan 1. It
   removes Codex edge N+1 reads, one redundant snapshot byte pass, and serial
   Cursor leaf inventory work without changing provider evidence.

These maintenance plans do not reorder the product roadmap. Digest-guarded
coordinate reads remain the next product milestone to shape; later product
milestones still wait for their predecessor's contract and acceptance evidence.
