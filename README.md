# Sessions

Local-first search and analysis for AI coding-agent session history.

Sessions will normalize Cursor, Codex, and future agent histories into one faithful local library. Humans and agents can preserve sessions beyond provider retention, recover or carry forward context, inspect decisions, audit drift and verification, and discover recurring work without uploading transcripts.

> **Status: pre-alpha.** The Codex-backed retained-library and query slice is
> implemented: explicit durable indexing, filtered/paginated list, lexical
> search with evidence context and support counts, show, scoped forget, all-data
> clear, source diagnostics, and the current canonical storage baseline.
> Portable export, Cursor, the packaged Agent Skill, and npm release remain
> planned.

## Why Sessions

- One provider-neutral query model instead of provider-specific workflows.
- Explicit, read-only indexing with no telemetry or cloud dependency.
- Durable normalized local snapshots that survive later provider disappearance.
- Provenance that distinguishes human, injected, delegated, copied, model, tool, and system content.
- Deduplicated evidence counts that do not mistake forks or copied prompts for independent recurrence.
- Human output for exploration, portable Markdown context, and versioned JSON/JSONL for scripts and agents.

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
node dist/bin/sessions.js show '<canonical-id>'
```

Current command surface:

```text
sessions doctor [--format human|json]
sessions paths [--format human|json]
sessions index [--source codex] [--format human|json]
sessions list [filters] [--limit N] [--cursor TOKEN]
sessions search <text> [filters] [--limit N] [--context N] [--cursor TOKEN]
sessions show <canonical-id> [--entry N --context N]
sessions forget <canonical-id> [--format human|json]
sessions data clear --yes [--format human|json]
```

`index` is the only ordinary command that reads Codex transcripts or initializes
the library. It copies normalized evidence into Sessions-owned application data;
a later complete scan that no longer sees a provider thread marks it missing but
retains its content. `list`, `search`, and `show` read only that durable library,
so they continue working when Codex data changes or disappears. They are
human-only in this milestone: list defaults to 50 sessions; search defaults to 20
entry hits and zero adjacent context; both accept at most 200 primary rows and
emit an opaque next cursor when another page exists. Show defaults to the first
50 entries or 3 entries of context around `--entry` (maximum context 100).

Search treats whitespace-delimited input as literal FTS terms combined with AND,
not as public FTS syntax. Each hit identifies one canonical entry, renders a
bounded snippet, can include up to 10 adjacent entries per side, and automatically
includes directly linked observed tool-call/result evidence. Query-wide support
reports matching segment occurrences, distinct canonical content, distinct known
lineage roots, and matching sessions whose root remains unknown. Shared filters,
exclusive time bounds, ranking, cursor invalidation, and exact output rules are in
the [CLI contract](docs/reference/cli-contract.md).

`forget` deletes one Sessions-owned retained copy without touching Codex. A later
index can capture it again while the provider still has it. `data clear --yes`
deletes the known Sessions database/sidecars and its exact temporary workspace.
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
sessions export <source-instance:id> --format md|json|jsonl [--full]
sessions index --source cursor
```

M7 adds versioned JSON/JSONL for transcript-bearing list/search/show results and
portable export. M6 list/search/show output remains human-facing.

The public delivery target is `npm install --global @ferueda/sessions` or `npx @ferueda/sessions`, after package ownership, cross-platform parity, and trusted publishing are configured.

## Privacy

Provider histories are inputs, never mutation targets. Indexing is explicit,
local, and network-free. It creates a durable normalized canonical snapshot in
platform application data; provider disappearance does not delete it. FTS/query
projections remain rebuildable, while only explicit forget/data-clear operations
remove retained content. See the [privacy contract](docs/privacy.md) for promises
and limitations.

## Design and roadmap

- [Project intent](docs/project-intent.md)
- [Accepted architecture memo](docs/architecture-memo.md)
- [V1 implementation roadmap](dev/plans/260713-v1-implementation-roadmap.md)
- [CLI contract](docs/reference/cli-contract.md)
- [Architecture decisions](docs/decisions/README.md)
- [Active implementation plans](dev/plans/README.md)

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [contributor index](docs/contributing/index.md). `pnpm check` is the repository definition of done.

## License

MIT
