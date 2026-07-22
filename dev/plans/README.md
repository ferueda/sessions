# Implementation plans

This directory holds the repository's active implementation plans.

- One plan per independently reviewable change.
- Plans describe outcomes, boundaries, exact change areas, and verification.
- Keep plans aligned with the current codebase; update them when scope changes.
- Remove completed plans. Git history remains the archive.

The durable product roadmap lives in the
[architecture memo](../../docs/architecture-memo.md#post-v1-roadmap).

## Active executor plans

- [Digest-guarded coordinate reads](260722-digest-guarded-coordinate-reads.md)
  add a caller-supplied document-digest precondition to existing `show` and
  `export` reads without adding revision storage or changing successful output.

Later product milestones still wait for this contract and its acceptance
evidence.
