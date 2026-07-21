# Architecture decisions

ADRs record durable choices and consequences. Product invariants remain in [project intent](../project-intent.md); the integrated design and roadmap remain in [the architecture memo](../architecture-memo.md).

Statuses: Proposed, Accepted, Superseded. A later ADR supersedes an accepted decision by linking both records; do not silently rewrite history.

- [0001 — Use a canonical local index](0001-use-a-canonical-local-index.md)
- [0002 — Isolate provider adapters](0002-isolate-provider-adapters.md)
- [0003 — Preserve provenance and deduplicated support](0003-preserve-provenance-and-deduplicated-support.md)
- [0004 — Publish a compiled Node.js CLI](0004-publish-a-compiled-node-cli.md)
- [0005 — Keep one-way ownership with Harness](0005-keep-one-way-ownership-with-harness.md) (Superseded by [0010](0010-install-sessions-directly-into-local-agent-hosts.md))
- [0006 — Evaluate skills from canonical evidence](0006-evaluate-skills-from-canonical-evidence.md)
- [0007 — Retain a durable canonical library](0007-retain-a-durable-canonical-library.md)
- [0008 — Make orphan-content deletion explicit](0008-explicit-orphan-content-repair.md)
- [0009 — Establish the supported release baseline](0009-establish-the-supported-release-baseline.md)
- [0010 — Install Sessions directly into local agent hosts](0010-install-sessions-directly-into-local-agent-hosts.md)

New ADRs should contain status/date, context, decision, consequences, and supersession links when relevant.
