# Sessions

Local-first search and analysis for AI coding-agent session history.

Sessions will normalize Cursor, Codex, and future agent histories into one faithful local library. Humans and agents can preserve sessions beyond provider retention, recover or carry forward context, inspect decisions, audit drift and verification, and discover recurring work without uploading transcripts.

> **Status: pre-alpha.** The Codex-backed retained-library and query slice is
> implemented: explicit durable indexing, bounded list/search/entries/show,
> portable JSON/JSONL export, scoped deletion, source diagnostics, orphan
> repair, and SQLite page reclamation. The packaged Sessions Agent Skill adds
> seven evidence-first analysis routes over those commands. Retained query pages
> now report capture scope so empty or partial results expose stale, unindexed,
> and unknown-coverage limits. Cursor indexing and
> the npm release remain planned; Markdown presentation is deferred beyond V1.

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

### Install the Agent Skill

The skill needs a working `sessions` command in the agent process. From this
repository checkout, install the packaged skill with:

```bash
npx skills add . --skill sessions
```

You can instead copy `skills/sessions/` into a host's skill directory, preserving
its layout. Codex and Cursor can host the skill, but the CLI currently indexes
Codex only. This pre-alpha guide documents only the locally verified install;
add the remote shorthand after an exact default-branch install is verified.

See [getting started](docs/getting-started.md) for the complete first-use flow
and [Agent Skill](docs/reference/agent-skill.md) for routes and limits.

Index the default local Codex installation, then inspect its retained copy:

```bash
node dist/bin/sessions.js doctor
node dist/bin/sessions.js index --source codex
node dist/bin/sessions.js list
node dist/bin/sessions.js list --source codex --native-id '<provider-thread-id>'
node dist/bin/sessions.js search 'query engine' --context 2
node dist/bin/sessions.js search 'query engine' --match any --format jsonl
node dist/bin/sessions.js search -- '-term'
node dist/bin/sessions.js entries --activity-after '2026-07-01T00:00:00.000Z' \
  --actor human --select last --format jsonl
node dist/bin/sessions.js show '<canonical-id>'
node dist/bin/sessions.js show '<canonical-id>' --from-entry 120 --to-entry 139
node dist/bin/sessions.js export '<canonical-id>' --format jsonl
```

Current command surface:

```text
sessions doctor [--format human|json]
sessions paths [--format human|json]
sessions index [--source codex] [--format human|json]
sessions list [filters] [--limit N] [--cursor TOKEN] [--format human|json|jsonl]
sessions search <text> [filters] [--match all|any] [--limit N] [--context N]
                       [--cursor TOKEN]
                       [--format human|json|jsonl]
sessions entries [filters] [--select all|first|last] [--limit N] [--cursor TOKEN]
                           [--format human|json|jsonl]
sessions show <canonical-id> [--entry N --context N | --from-entry N --to-entry N]
                             [--format human|json|jsonl]
sessions export <canonical-id> --format json|jsonl
                               [--full | --from-entry N --to-entry N]
sessions forget <canonical-id> [--format human|json]
sessions data repair-orphans [--format human|json]
sessions data compact [--format human|json]
sessions data clear --yes [--format human|json]
```

Use the shared exact `--native-id` filter with `list` to resolve a known
provider-native session or thread ID to its canonical Sessions identity. It may
return more than one retained session across source instances; add `--source`
and `--instance` to narrow the match. The same filter scopes transcript
`search`, while `show`, `export`, and `forget` continue to require the
unambiguous canonical ID returned by list.

`index` is the only ordinary command that reads Codex transcripts or initializes
the library. It copies normalized evidence into Sessions-owned application data;
a later complete scan that no longer sees a provider thread marks it missing but
retains its content. `list`, `search`, `entries`, and `show` read only that durable library,
so they continue working when Codex data changes or disappears. They support
human, JSON, and independently attributable JSONL output. List defaults to 50
sessions; search defaults to 20 entry hits and zero adjacent context; both accept
at most 200 primary rows and emit an opaque next cursor when another page exists.
Show defaults to the first 50 entries or 3 entries of context around `--entry`
(maximum context 100). Show and export also accept one inclusive
`--from-entry`/`--to-entry` range of at most 200 entries. Both options are
required; invalid, reversed, conflicting, or out-of-document ranges fail rather
than being clamped. Format does not change query ordering or cursor identity.

Search treats whitespace-delimited input as literal terms, not public FTS syntax.
`--match all` is the default; `--match any` returns hits for any term and reports
the exact matched terms on each hit. A query accepts at most 32 terms and 4 KiB
of canonical UTF-8 text. Use the `--` delimiter before search text that begins
with a dash; unknown flags remain usage errors. Each hit identifies one canonical
entry, renders a bounded snippet, can include up to 10 adjacent entries per side,
and automatically includes directly linked observed tool-call/result evidence.
Query-wide support
reports matching segment occurrences, distinct canonical content, distinct known
lineage roots, and matching sessions whose root remains unknown. Shared filters,
exclusive time bounds, ranking, cursor invalidation, and exact output rules are in
the [CLI contract](docs/reference/cli-contract.md).

List, search, and entries return a query-derived known retained root or
`unknown`. Shared activity bounds use `updatedAt`, falling back to `createdAt`;
sessions missing both timestamps do not match. Root attribution is not added to
show, export, canonical documents, or document digests.

Those three paged queries also return one aggregate `captureScope`. It reports
tracked, retained-current, retained-stale, unindexed, effective source-state,
source-coverage, and latest-failure counts without identities or filter values.
`appliedFilters` names source/tracking filters the aggregate can evaluate;
`unassessedFilters` names canonical metadata, entry, or search-text filters that
cannot classify an unindexed session. Capture scope describes evidence
availability. Search `support` still counts retained matches only.

`entries` inventories retained entry structure without requiring search text.
It can return all matching entries or the first/last canonical ordinal per
session after exact entry filters. Results stay in binary source identity and
entry-ordinal order, include one bounded origin-aware text preview when
available, exact text/omission counts, observed tool/linkage fields, and a known
or unknown retained root. Pagination is opaque and stable for one library
generation. See [entry inventory](docs/contributing/entries.md) for the query
flow and cost.

`export` extracts one retained canonical snapshot as JSON or JSONL without
reopening Codex, following relations, or delivering it anywhere. Default
show/export output applies explicit title, relation, entry, segment, and raw-text
bounds after entry selection. A selected range can still contain truncated text
or omitted segments under those bounds. Every result keeps the digest of the
complete retained document, not a digest of the selected range. Sessions still
reads and validates that complete document before selecting the range.
`export --full` removes presentation bounds for export-eligible fields in that
one snapshot; it does not expose raw provider payloads or omitted media. Every
transcript-bearing structured record is marked
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
For a ready library, incomplete capture evidence is a warning with `ok: true`;
canonical, foreign-key, FTS, reachability, run, and lease failures keep their
existing failed-health semantics.

Pre-alpha builds recognize one current on-disk baseline. Databases created by
earlier development builds are not upgraded or deleted automatically; use a fresh
`SESSIONS_DATA_DIR` or manually remove the old Sessions-owned directory and index
again. Data-preserving forward migrations become a compatibility promise with the
first published release.

An index writer marks its lease generation dirty when acquired. A normal close
can seal only that exact generation and publish a private, bounded post-close
proof tied to the final database file state. The next clean open uses current
schema and FTS-structure checks plus proportional verification of changed
content. Recovery, migration, maintenance, failed cleanup, or missing proof uses
the full canonical, foreign-key, and FTS validation/repair path. Direct SQLite
edits outside Sessions are unsupported. `doctor` remains an immutable semantic
check of canonical and FTS terms and positions.

Codex defaults to `~/.codex`. `CODEX_HOME` selects another Codex home. The state
database location follows Codex's `sqlite_home` configuration, then
`CODEX_SQLITE_HOME`, then the Codex home. See the
[Codex format support reference](docs/reference/codex-format-support.md) for the
supported state and rollout shapes.

## Remaining V1

```text
sessions index --source cursor
```

M9 packaged Agent Skill work and M10 capture/routine-index hardening are
complete. The clean-open proof reduced a fixed synthetic 2,000-session run to
2.767 ms writer open / 264.666 ms total, and an authorized read-only real Codex
120-session run to 3.262 ms / 366.055 ms with zero changed reads and exact
cohort equality. M11 begins with a provider-neutral changed-read capture
workspace, then adds Cursor parity through the same engine. Markdown remains
deferred beyond V1; `--format md` is not accepted today.

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
- [Cursor source survey](docs/research/cursor-source-survey.md)
- [CLI contract](docs/reference/cli-contract.md)
- [Structured output contract](docs/reference/structured-output.md)
- [Agent Skill](docs/reference/agent-skill.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Architecture decisions](docs/decisions/README.md)
- [Active implementation plans](dev/plans/README.md)

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [contributor index](docs/contributing/index.md). `pnpm check` is the repository definition of done.

## License

MIT
