# Implementation plans

This directory holds the repository's active implementation plans.

- One plan per independently reviewable change.
- Plans describe outcomes, boundaries, exact change areas, and verification.
- Keep plans aligned with the current codebase; update them when scope changes.
- Remove completed plans. Git history remains the archive.

Program roadmap: [Sessions V1 implementation roadmap](260713-v1-implementation-roadmap.md).

Active executor plans, in order:

- [Deliver JSON and JSONL structured output](260715-json-jsonl-structured-delivery.md)

The canonical export foundation is implemented: one provider-neutral public
projection, deterministic document digest, atomic persistence/verification, and
same-snapshot attribution. The active plan exposes that contract through bounded
JSON/JSONL list, search, show, and export commands. Markdown export remains
deferred presentation work after M8 and before M9/V1; M8 may proceed once the
provider-neutral JSON/JSONL contract is complete.
