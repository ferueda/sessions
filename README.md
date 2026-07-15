# Sessions

Local-first search and analysis for AI coding-agent session history.

Sessions will normalize Cursor, Codex, and future agent histories into one faithful local library. Humans and agents can preserve sessions beyond provider retention, recover or carry forward context, inspect decisions, audit drift and verification, and discover recurring work without uploading transcripts.

> **Status: pre-alpha.** The Codex-backed retained-library and query slice is
> implemented: explicit durable indexing, filtered/paginated list, lexical
> search with evidence context and support counts, show, scoped forget, all-data
> clear, explicit orphan-content diagnosis/repair, explicit SQLite page
> reclamation, source diagnostics, versioned JSON/JSONL query output, and
> portable retained-session export. Cursor, Markdown presentation, the packaged
> Agent Skill, and npm release remain planned.

## Why Sessions

- One provider-neutral query model instead of provider-specific workflows.
- Explicit, read-only indexing with no telemetry or cloud dependency.
- Durable normalized local snapshots that survive later provider disappearance.
- Provenance that distinguishes human, injected, delegated, copied, model, tool, and system content.
- Deduplicated evidence counts that do not mistake forks or copied prompts for independent recurrence.
- Human output for exploration and versioned JSON/JSONL for scripts, agents, and portable retained context.

## Current quick start

Prerequisites: Node.js 24.16 or newer and pnpm 11.10 through Corepack.

```bash
git clone https://github.com/ferueda/sessions.git
cd sessions
corepack enable
pnpm install --frozen-lockfile
pnpm build
node dist/bin/sessions.js doctor
```

Index the default local Codex installation, then inspect its retained copy:

```bash
node dist/bin/sessions.js doctor
node dist/bin/sessions.js index --source codex
node dist/bin/sessions.js list
node dist/bin/sessions.js search 'query engine' --context 2
node dist/bin/sessions.js search -- '-term'
node dist/bin/sessions.js show '<canonical-id>'
node dist/bin/sessions.js export '<canonical-id>' --format jsonl
```

Current command surface:

```text
sessions doctor [--format human|json]
sessions paths [--format human|json]
sessions index [--source codex] [--format human|json]
sessions list [filters] [--limit N] [--cursor TOKEN] [--format human|json|jsonl]
sessions search <text> [filters] [--limit N] [--context N] [--cursor TOKEN]
                       [--format human|json|jsonl]
sessions show <canonical-id> [--entry N --context N] [--format human|json|jsonl]
sessions export <canonical-id> --format json|jsonl [--full]
sessions forget <canonical-id> [--format human|json]
sessions data repair-orphans [--format human|json]
sessions data compact [--format human|json]
sessions data clear --yes [--format human|json]
```

`index` is the only ordinary command that reads Codex transcripts or initializes
the library. It copies normalized evidence into Sessions-owned application data;
a later complete scan that no longer sees a provider thread marks it missing but
retains its content. `list`, `search`, and `show` read only that durable library,
so they continue working when Codex data changes or disappears. They support
human, JSON, and independently attributable JSONL output. List defaults to 50
sessions; search defaults to 20 entry hits and zero adjacent context; both accept
at most 200 primary rows and emit an opaque next cursor when another page exists.
Show defaults to the first 50 entries or 3 entries of context around `--entry`
(maximum context 100). Format does not change query ordering or cursor identity.

Search treats whitespace-delimited input as literal FTS terms combined with AND,
not as public FTS syntax. Use the `--` delimiter before search text that begins
with a dash; unknown flags remain usage errors. Each hit identifies one canonical entry, renders a
bounded snippet, can include up to 10 adjacent entries per side, and automatically
includes directly linked observed tool-call/result evidence. Query-wide support
reports matching segment occurrences, distinct canonical content, distinct known
lineage roots, and matching sessions whose root remains unknown. Shared filters,
exclusive time bounds, ranking, cursor invalidation, and exact output rules are in
the [CLI contract](docs/reference/cli-contract.md).

`export` extracts one retained canonical snapshot as JSON or JSONL without
reopening Codex, following relations, or delivering it anywhere. Default
show/export output applies explicit title, relation, entry, segment, and raw-text
bounds. `export --full` removes those presentation bounds for export-eligible
fields in that one snapshot; it does not expose raw provider payloads or omitted
media. Every transcript-bearing structured record is marked
`untrusted-history`, and every bounded machine result is encoded fully before
stdout and limited to 16 MiB. See the
[structured output contract](docs/reference/structured-output.md) for the exact
schema, null rules, bounds, and trust limits.

`forget` deletes one Sessions-owned retained copy without touching Codex. A later
index can capture it again while the provider still has it. Deleted database
pages become reusable, but forget does not promise immediate file shrink.
`doctor` reports canonical content that no retained occurrence reaches;
`data repair-orphans` explicitly deletes that unreachable text in fixed internal
batches without resolving a provider. Its row and logical UTF-8 byte totals are
not reclaimed-disk measurements. A failed invocation can leave completed batches
durably deleted and is safe to rerun; there is no public limit, cursor, or partial
report.
`data compact` explicitly returns reusable whole pages to the filesystem in
bounded batches; it does not remove canonical evidence or repack partially used
pages. A failed run can leave completed batches durably reclaimed and is safe to
rerun. Its byte report is the observed main-database file length, not guaranteed
savings. `data clear --yes` deletes the known Sessions database/sidecars and its
exact temporary workspace.
`doctor` and `paths` inspect runtime, library, and Codex source readiness without
indexing or creating state. All runtime operation is local, network-free, and
telemetry-free.

Pre-alpha builds recognize one current on-disk baseline. Databases created by
earlier development builds are not upgraded or deleted automatically; use a fresh
`SESSIONS_DATA_DIR` or manually remove the old Sessions-owned directory and index
again. Data-preserving forward migrations become a compatibility promise with the
first published release.

Codex defaults to `~/.codex`. `CODEX_HOME` selects another Codex home. The state
database location follows Codex's `sqlite_home` configuration, then
`CODEX_SQLITE_HOME`, then the Codex home. See the
[Codex format support reference](docs/reference/codex-format-support.md) for the
supported state and rollout shapes.

## Remaining V1

```text
sessions index --source cursor
sessions export <canonical-id> --format md [--full]
```

M7 JSON/JSONL delivery is complete, so M8 Cursor parity is next. Markdown remains
a separate presentation layer over the same public projection after M8 and
before M9/V1; `--format md` is not accepted today.

The public delivery target is `npm install --global @ferueda/sessions` or `npx @ferueda/sessions`, after package ownership, cross-platform parity, and trusted publishing are configured.

## Privacy

Provider histories are inputs, never mutation targets. Indexing is explicit,
local, and network-free. It creates a durable normalized canonical snapshot in
platform application data; provider disappearance does not delete it. FTS/query
projections remain rebuildable, while only explicit forget, orphan repair, or
data-clear operations remove retained content. Explicit compaction changes
physical allocation only.
See the [privacy contract](docs/privacy.md) for promises and limitations.

## Design and roadmap

- [Project intent](docs/project-intent.md)
- [Accepted architecture memo](docs/architecture-memo.md)
- [V1 implementation roadmap](dev/plans/260713-v1-implementation-roadmap.md)
- [CLI contract](docs/reference/cli-contract.md)
- [Structured output contract](docs/reference/structured-output.md)
- [Architecture decisions](docs/decisions/README.md)
- [Active implementation plans](dev/plans/README.md)

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [contributor index](docs/contributing/index.md). `pnpm check` is the repository definition of done.

## License

MIT
