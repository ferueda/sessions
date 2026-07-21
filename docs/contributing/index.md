# Contributor index

Start here:

1. [Project intent](../project-intent.md) — purpose, non-goals, hard invariants.
2. [Architecture memo](../architecture-memo.md) — accepted target and roadmap.
3. [Setup](setup.md) — contributor requirements and generated state.
4. [Current architecture](architecture.md) — code ownership and dependency direction.
5. [Testing](testing.md) — proof layers and definition of done.

User guides:

- [Getting started](../getting-started.md) — CLI, Agent Skill, first index, and
  bounded analysis.
- [Troubleshooting](../troubleshooting.md) — readiness, search, evidence, reset,
  and storage behavior.

Core areas:

- [Indexing](indexing.md) — discovery, incremental capture, and last-good behavior.
- [Search](search.md) — matching, ranking, context, support, and pagination.
- [Entry inventory](entries.md) — textless selection, previews, roots, and pagination.
- [Storage](storage.md) — canonical records, content reuse, digests, and FTS.
- [Lineage](lineage.md) — root resolution and known/unknown evidence.
- [Maintenance](maintenance.md) — writer leases, deletion, repair, compaction, and clear.

Contracts:

- [Privacy](../privacy.md)
- [CLI](../reference/cli-contract.md)
- [Agent Skill](../reference/agent-skill.md)
- [Codex format support](../reference/codex-format-support.md)
- [Cursor format support](../reference/cursor-format-support.md)
- [Source adapters](adapter-contract.md)
- [Repository commands](commands.md)
- [Releasing](releasing.md)
- [V1 standalone acceptance](v1-acceptance.md)
- [Architecture decisions](../decisions/README.md)

Research baselines:

- [Codex source survey](../research/codex-source-survey.md) — sanitized source,
  schema, compatibility, and Harness-reference findings before M5.
- [Cursor source survey](../research/cursor-source-survey.md) — official product
  semantics, sanitized local formats, capture-workspace prerequisite, and M11
  boundaries.
- [Cursor local format v1 evidence](../research/cursor-format-v1.md) — exact
  M11b field, authority, ordering, normalization, and failure matrix.

Active implementation work is indexed in [`dev/plans/README.md`](../../dev/plans/README.md).
