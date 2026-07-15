# Implementation plans

This directory holds the repository's active implementation plans.

- One plan per independently reviewable change.
- Plans describe outcomes, boundaries, exact change areas, and verification.
- Keep plans aligned with the current codebase; update them when scope changes.
- Remove completed plans. Git history remains the archive.

Program roadmap: [Sessions V1 implementation roadmap](260713-v1-implementation-roadmap.md).

Active executor plans, in implementation order:

1. [Make writer leases safe for long SQLite transactions](260714-writer-lease-scalability.md).
2. [Accept current Codex session metadata](260714-codex-session-metadata-compatibility.md).
   Its live V3 acceptance depends on the writer-lease fix.
3. [Harden M6 query and CLI shipping proofs](260714-m6-query-cli-proof-hardening.md).

Resume M7 after these dogfood-hardening plans.
