# Implementation plans

This directory holds the repository's active implementation plans.

- One plan per independently reviewable change.
- Plans describe outcomes, boundaries, exact change areas, and verification.
- Keep plans aligned with the current codebase; update them when scope changes.
- Remove completed plans. Git history remains the archive.

Program roadmap: [Sessions V1 implementation roadmap](260713-v1-implementation-roadmap.md).

M10 capture truth, recovery, measurement, and recovery-safe writer-open
optimization are complete. M11a extended the private capture workspace to
changed reads.

Active executor plan:

- [Make registered providers optional by default](260716-optional-provider-defaults.md)

Land this provider-neutral prerequisite before registering Cursor in M11b.
Markdown presentation remains deferred beyond V1.
