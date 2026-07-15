# CLI contract

- Status: current M6 behavior plus accepted later-V1 semantics
- Last updated: 2026-07-14

Generated `sessions --help` owns exact current flags. This document owns behavior
and compatibility. Planned commands are labeled explicitly.

Pre-alpha structured schemas may reset before publication. Compatibility begins
with the first published contract; no earlier development contract is supported.

## Current commands

```text
sessions
sessions --help
sessions --version
sessions doctor [--format human|json]
sessions paths [--format human|json]
sessions index [--source codex] [--format human|json]
sessions list [--source SOURCE] [--instance INSTANCE]
              [--source-state present|missing|unknown] [--workspace WORKSPACE]
              [--captured-after TIME] [--captured-before TIME]
              [--observed-after TIME] [--observed-before TIME]
              [--session CANONICAL-ID] [--limit N] [--cursor TOKEN]
sessions search <text> [--source SOURCE] [--instance INSTANCE]
                       [--source-state present|missing|unknown]
                       [--workspace WORKSPACE]
                       [--captured-after TIME] [--captured-before TIME]
                       [--observed-after TIME] [--observed-before TIME]
                       [--session CANONICAL-ID]
                       [--entry-after TIME] [--entry-before TIME]
                       [--actor ACTOR] [--origin ORIGIN] [--kind KIND]
                       [--tool-name NAME] [--tool-namespace NAMESPACE]
                       [--limit N] [--context N] [--cursor TOKEN]
sessions show <canonical-id> [--entry N --context N]
sessions forget <canonical-id> [--format human|json]
sessions data clear --yes [--format human|json]
```

The bare command prints help. `index` is the only ordinary command that reads
rollout content or initializes the durable library. `forget` mutates only a
current initialized library. `doctor` and `paths` inspect runtime, library, and
registered-source readiness without indexing or creating state.

`index` selects all registered sources when `--source` is omitted. The only
current source is `codex`; an unknown source is invalid usage before writer open.
A complete report exits `0`; an incomplete report is fully rendered and exits
`1`. A successful capture stores the latest canonical snapshot. Complete later
absence marks it missing without deletion; incomplete discovery leaves source
state unknown.

`list` defaults to 50 and accepts 1 through 200. Activity is
`updatedAt`, falling back to `createdAt`; missing activity sorts last, then
activity descends, then the raw source/instance/native tuple ascends with binary
collation. When another page exists, output ends with the copyable
`Next cursor: <token>` line. A fresh library renders exactly
`No sessions found.` plus a newline, exits `0`, and does not create state or
resolve Codex.

`search` requires non-blank text, defaults to 20 primary hits, and accepts 1
through 200. `--context` defaults to 0 and accepts 0 through 10 adjacent entries
on each side. A no-match result renders exactly `No matches found.` plus a
newline and exits `0`. Search, list, and show read one immutable retained-library
snapshot per operation and never resolve or reopen Codex.

`show` defaults to the first 50 entries. `--entry N` focuses one entry with 3
entries of context on each side by default; `--context` accepts 0 through 100 and
requires `--entry`. Missing session/entry values are operational failures.
List/search/show are human-only until M7. They report applicable
freshness/source-state/capture evidence, omit diagnostic locators and workspace
from output, and escape/bound untrusted terminal content.

`forget` idempotently deletes one retained Sessions copy and returns `forgotten`
or `absent`. `data clear` requires `--yes` and deletes all known Sessions-owned
state. Both leave provider data untouched.

### Doctor JSON

`sessions doctor --format json` writes one JSON document:

```json
{
  "schemaVersion": 1,
  "command": "doctor",
  "ok": true,
  "checks": [
    {
      "id": "node-runtime",
      "label": "Node.js runtime",
      "ok": true,
      "summary": "Node.js 26.4.0 satisfies >=24.16.0",
      "details": {
        "version": "26.4.0",
        "minimumVersion": "24.16.0"
      }
    }
  ]
}
```

Check IDs, field names, and `schemaVersion` are machine-facing. Summaries are human-facing. Checks run in declared order and continue after failure. A thrown probe becomes a sanitized failed check.

The current check order is `node-runtime`, `sqlite-fts5`, `library-state`, then
`source-codex`. The SQLite check reports `sqliteVersion` and `fts5SecureDelete`
(`supported` or `unsupported`) in `details`; lack of FTS5 fails. An uninitialized
library passes. Every non-ready initialized state fails. Ready Codex passes;
unavailable or unreadable Codex fails without reading rollout content.

For `ready`, the library check uses an immutable snapshot and adds
`canonicalIntegrity`, `foreignKeys`, `ftsStructure`, `ftsContent`,
`ftsSecureDelete`, `ftsRemediation`, `runRecords`, `writerLease`, `activeRuns`,
and `interruptedRuns` to `details`. Checks are `ok | failed`; FTS secure delete is
`enabled | missing | unsupported`; remediation is
`not-needed | rebuild-required`; writer lease is `free | index-live |
forget-live | clear-live | expired | invalid`; counts are non-negative decimal
strings. Canonical/foreign-key/run corruption fails. FTS-only damage reports
rebuild-required without describing canonical loss. An active run is healthy only
with an index-live lease. Doctor never opens a writer or applies migrations.

All-pass and failed-check reports go to stdout. All-pass exits `0`; any failed check exits `1`; both leave stderr empty. Invalid usage writes to stderr and exits `2`. An unexpected failure outside probe aggregation writes a concise stderr diagnostic and exits `1` without fabricating a report.

### Paths JSON

`sessions paths --format json` writes one schema-1 document. Before
initialization, a Linux default may look like:

```json
{
  "schemaVersion": 1,
  "command": "paths",
  "library": {
    "directory": "/home/user/.local/share/sessions",
    "scratch": "/home/user/.local/share/sessions/.scratch",
    "database": "/home/user/.local/share/sessions/sessions.sqlite3",
    "wal": "/home/user/.local/share/sessions/sessions.sqlite3-wal",
    "shm": "/home/user/.local/share/sessions/sessions.sqlite3-shm",
    "initialized": false,
    "state": "uninitialized",
    "schemaVersion": null,
    "supportedSchemaVersion": 1
  },
  "sources": []
}
```

Schema 1 reports the Sessions-owned application-data library, scratch workspace,
known database/sidecar paths, state, schema support, and admitted source probes.
Current state values are `uninitialized`, `ready`, `migration-required`,
`newer-schema`, `incompatible`, `recovery-required`, and `unsafe`.

The human format presents the same fields. An incompatible state is still a paths
report and exits `0`; doctor evaluates health. Resolution/inspection failure emits
no partial report and exits `1`.

## Remaining V1 commands

```text
sessions export <source-instance:id> --format md|json|jsonl [--full]
sessions index --source cursor
```

These routes are added to generated help only when implemented and contract-tested.

## Current retention and empty-library semantics

`sessions index` creates or refreshes the latest successful normalized canonical
snapshot as durable local user data. A complete later scan may mark the retained
session missing but never deletes it. Unavailable, unreadable, malformed, or
incomplete discovery proves no absence. No TTL or automatic pruning applies.

`sessions forget` deletes one Sessions-owned canonical snapshot/tracking record,
its owned evidence, identity-bearing historical run-item details, and now-unused
derived content without touching the provider. Aggregate run diagnostics and
incoming relation references owned by other retained snapshots remain; forget is
not a global text/reference erasure operation. If the provider still exposes the
session, a later explicit index can capture it again. `sessions data clear`
requires `--yes` and removes only the known Sessions library database/WAL/SHM
files plus the exact ephemeral scratch subtree. Rebuilding derived FTS/query
state is a different, non-destructive operation and is not a public command. An
explicit leased `index` writer verifies the canonical library first and repairs
FTS-only structure/content damage from canonical content. Doctor remains
read-only and reports `rebuild-required`; canonical corruption fails closed
instead of invoking projection repair.

On a fresh uninitialized library, `sessions list` and a cursor-free
`sessions search` exit `0`, write their exact empty messages to stdout, and leave
stderr empty. They do not create storage, run migrations, open a reader, or
resolve/probe an adapter. Initialized-but-empty uses the same output through a
normal read snapshot. A supplied cursor against absent/recreated state is stale.
Other initialized non-ready states remain operational failures. `show` of an
absent identity, including in an uninitialized library, remains a sanitized
not-found operational failure.

## Current operational JSON

The current pre-alpha operational reports are exact test-backed contracts.
Transcript-bearing list/search/show output remains human-only until the M7 DTO
work.

`sessions index --format json` emits the current schema-1 report. A complete
representative report is:

```json
{
  "schemaVersion": 1,
  "command": "index",
  "startedAt": "2026-07-14T12:00:00.000Z",
  "finishedAt": "2026-07-14T12:01:00.000Z",
  "counts": {
    "discovered": 2,
    "unchanged": 0,
    "updated": 1,
    "failed": 1,
    "missing": 1,
    "stale": 1
  },
  "sources": [
    {
      "schemaVersion": 1,
      "source": {
        "kind": "codex",
        "instanceId": "local-sha256-v1:0000000000000000000000000000000000000000000000000000000000000000"
      },
      "status": "completed",
      "coverage": {
        "status": "complete",
        "observedAt": "2026-07-14T12:00:00.000Z"
      },
      "startedAt": "2026-07-14T12:00:00.000Z",
      "finishedAt": "2026-07-14T12:01:00.000Z",
      "counts": {
        "discovered": 2,
        "unchanged": 0,
        "updated": 1,
        "failed": 1,
        "missing": 1,
        "stale": 1
      },
      "items": [
        {
          "identity": {
            "canonicalId": "codex@local-sha256-v1%3A0000000000000000000000000000000000000000000000000000000000000000:changed-thread",
            "source": {
              "kind": "codex",
              "instanceId": "local-sha256-v1:0000000000000000000000000000000000000000000000000000000000000000"
            },
            "nativeId": "changed-thread"
          },
          "outcome": "failed",
          "failure": "source-changed"
        },
        {
          "identity": {
            "canonicalId": "codex@local-sha256-v1%3A0000000000000000000000000000000000000000000000000000000000000000:missing-thread",
            "source": {
              "kind": "codex",
              "instanceId": "local-sha256-v1:0000000000000000000000000000000000000000000000000000000000000000"
            },
            "nativeId": "missing-thread"
          },
          "outcome": "missing"
        }
      ],
      "omittedItemCount": 0
    }
  ],
  "incompleteSources": 0,
  "omittedItemCount": 0
}
```

Counts are non-negative safe integers and use exactly `discovered`, `unchanged`,
`updated`, `failed`, `missing`, and `stale`. `discovered = unchanged + updated +
failed`; missing is reconciliation rather than discovery. Items contain a
`identity` with exact `canonicalId`, `source`, and opaque `nativeId`, and are
either `missing`, or `failed` with one of
`unavailable`, `unreadable`, `malformed`, `source-changed`,
`unsupported-format`, or `repository-write`. A source is either `completed` with
complete coverage and no `failure`, or `incomplete` with unknown coverage and one
of `source-unavailable`, `source-unreadable`, `probe-failed`, `discovery-failed`,
`interrupted`, or `repository-write`. Source reports sort by raw source tuple;
items retain persisted run-item order. Top counts and omissions are safe sums.

Forget and all-data deletion emit these exact schema-1 shapes:

```json
{
  "schemaVersion": 1,
  "command": "forget",
  "identity": {
    "canonicalId": "codex@local:thread-id",
    "source": { "kind": "codex", "instanceId": "local" },
    "nativeId": "thread-id"
  },
  "outcome": "forgotten"
}
```

`outcome` is `forgotten | absent`.

```json
{
  "schemaVersion": 1,
  "command": "data-clear",
  "outcome": "cleared",
  "scratchRemoved": true,
  "databaseRemoved": true,
  "walRemoved": true,
  "shmRemoved": false
}
```

`outcome` is `cleared | absent`; each file boolean reports the named known file,
and `scratchRemoved` reports the exact owned subtree. `absent` requires every
boolean to be false. Orphan scratch without its lease-bearing database is a
recovery-required failure, not a successful report.

Paths schema 1 uses `library` and includes admitted source probes:

```json
{
  "schemaVersion": 1,
  "command": "paths",
  "library": {
    "directory": "/home/user/.local/share/sessions",
    "scratch": "/home/user/.local/share/sessions/.scratch",
    "database": "/home/user/.local/share/sessions/sessions.sqlite3",
    "wal": "/home/user/.local/share/sessions/sessions.sqlite3-wal",
    "shm": "/home/user/.local/share/sessions/sessions.sqlite3-shm",
    "initialized": false,
    "state": "uninitialized",
    "schemaVersion": null,
    "supportedSchemaVersion": 1
  },
  "sources": [
    {
      "source": {
        "kind": "codex",
        "instanceId": "local-sha256-v1:0000000000000000000000000000000000000000000000000000000000000000"
      },
      "probe": {
        "status": "ready",
        "locations": [
          { "role": "codex-home", "uri": "file:///home/user/.codex" },
          { "role": "sqlite-home", "uri": "file:///home/user/.codex" }
        ]
      }
    }
  ]
}
```

Library state values remain `uninitialized`, `ready`, `migration-required`,
`newer-schema`, `incompatible`, `recovery-required`, and `unsafe`. An admitted
probe status is `ready | unavailable | unreadable`; sources sort by raw identity
tuple and Codex's two canonical file-URL locations keep the shown order even when
equal. A malformed/thrown probe becomes
`{ "status": "failed", "failure": "invalid-probe" | "probe-error", "locations": [] }`
without failing paths. Failure before a stable source identity exists, or library
inspection failure, emits no partial report and exits `1`.

Doctor schema 1 uses `{ schemaVersion, command: "doctor", ok, checks }` and each
`{ id, label, ok, summary, details }` check. Check order is `node-runtime`,
`sqlite-fts5`, `library-state`, `source-codex`. The ready `library-state` string
details are exactly `state`, `initialized`, `schemaVersion`,
`supportedSchemaVersion`, `canonicalIntegrity`, `foreignKeys`, `ftsStructure`,
`ftsContent`, `ftsSecureDelete`, `ftsRemediation`, `runRecords`, `writerLease`,
`activeRuns`, and `interruptedRuns`; non-ready states retain the first four and
add only applicable `reason`/`target`. `canonicalIntegrity`, foreign-key, FTS
structure/content, and run-record values are `ok | failed`; FTS secure-delete is
`enabled | missing | unsupported`; FTS remediation is
`not-needed | rebuild-required`; writer-lease values are `free`, `index-live`,
`forget-live`, `clear-live`, `expired`, or `invalid`.

An admitted `source-codex` check has only `probeStatus` with value
`ready | unavailable | unreadable`. Ready passes; unavailable/unreadable fails. A
malformed or thrown probe fails with exactly
`{ "probeStatus": "failed", "failure": "invalid-probe" | "probe-error" }`.
Doctor never duplicates the roots owned by paths. Summaries and labels are
human-facing; IDs, order, detail keys/values, and schema version are
machine-facing.

## Current query contract

Canonical printable IDs use
`<kind>@<percent-encoded-instance-id>:<percent-encoded-native-id>`, for example
`codex@default:opaque-id`. Kind is an open lowercase adapter slug. Instance and
native IDs are case-sensitive opaque values; delimiters are escaped and values
are never Unicode-normalized.

### Shared list/search filters

Each filter accepts one value; different filters combine with AND. Exact values
use their case-sensitive canonical representation:

- `--source` selects an exact source kind. `--instance` selects an exact source
  instance and requires `--source`.
- `--source-state` accepts `present`, `missing`, or `unknown`.
- `--workspace` selects the exact retained workspace value.
- `--captured-after` / `--captured-before` bound successful capture time.
- `--observed-after` / `--observed-before` bound effective source-observation
  time.
- `--session` selects one exact canonical identity.

Times must be canonical UTC with milliseconds, such as
`2026-07-14T12:00:00.000Z`. Every `after`/`before` bound is exclusive; equal or
inverted pairs are invalid usage. A missing timestamp does not satisfy either
bound.

Effective source state is `unknown` while the source instance's latest coverage
is unknown; otherwise it is that retained session's `present`/`missing` tracking
state. Effective source-observation time follows the same evidence boundary: use
the source coverage observation while coverage is unknown, otherwise use the
session presence observation. `lastSeenAt`, capture time, and provider activity
time are never substituted.

### Search text, filters, and hits

Search splits well-formed input on Unicode whitespace, quotes every non-empty
term as literal FTS data, and joins terms with logical AND. Quotes, FTS keywords,
paths, opaque IDs, operators, and punctuation are never interpreted as public
FTS syntax. CLI argument parsing happens first: use `sessions search -- "-term"`
when search text begins with a dash. Without the delimiter, a leading-dash token
is an unknown option and invalid usage. Blank input is invalid usage. Non-blank
input that yields no tokens under the fixed FTS5 `unicode61` tokenizer succeeds with no matches.
Lexical case/diacritic behavior follows that tokenizer; it is distinct from the
case-sensitive exact filters below.

Search-only filters are:

- exclusive `--entry-after` / `--entry-before` canonical entry timestamps;
- exact `--actor` values `human`, `model`, `tool`, `system`, or `unknown`;
- exact `--origin` values `human`, `injected`, `delegated`, `replayed-copied`,
  `model`, `tool`, `system`, or `unknown`;
- exact `--kind`, `--tool-name`, and `--tool-namespace` values.

Filters constrain the primary matching occurrence/entry; returned context need
not satisfy them. Origin applies to the matching text occurrence. Tool-name and
namespace are separate observed fields, combine with AND, and select canonical
`tool-call` entries only. A call without a namespace does not match a namespace
filter. Text mentions, injected catalogs, and agent claims never manufacture a
call or prove a named skill/workflow ran.

Qualifying text occurrences group by canonical session identity and entry
ordinal, yielding one primary hit per entry. The best-ranked matching segment,
then its lowest segment ordinal, supplies the snippet; the hit reports other
matching segments without duplicating the entry. Page limits count primary hits,
not matching segments or context.

Entry rank uses the best content-level FTS5 BM25 value, then effective session
activity (`updatedAt`, falling back to `createdAt`) descending with missing values
last, then binary source kind/instance/native identity ascending, then entry
ordinal. Repeated occurrences do not improve relevance. These tie rules make the
same retained snapshot and query deterministic.

Each snippet and context body is at most 512 UTF-8 bytes and marks truncation.
Human rendering uses the `… [truncated]` suffix.
`--context N` adds at most N neighboring entries on each side. Independently,
search adds direct inbound/outbound relation partners only when the observed pair
is one `tool-call` and one `tool-result`. Linked expansion is non-recursive,
deduplicated, ordinal-sorted, capped at 20 additions, and reports truncation.
Turn/lifecycle and every other `relatedEntryOrdinal` pairing are excluded.
Results retain their relation but never inherit call name or namespace. When the
linked cap is exceeded, output includes
`Linked context: truncated at 20 entries`.

### Query-wide support and lineage

Search support is calculated after all filters and before page slicing:

- matching text-segment occurrences;
- distinct collision-safe canonical content values;
- distinct resolved known session roots; and
- distinct matching sessions whose root cannot be resolved.

Canonical documents record lineage coverage as `complete` or `unknown`.
High-confidence parent, fork, and continuation targets point rootward; child
targets are outward and do not change the current root. Complete coverage with no
rootward edge proves the session is its own root. Unknown coverage/kind,
non-high-confidence ancestry, a missing retained target, a cycle, or ancestry
paths that diverge to different roots stays unknown. Paths that converge on one
root remain known. Equal text/hash and inverse-relation inference never create
lineage, and one support unit is never substituted for another.

### Continuation cursors

List and search expose an opaque next cursor only when more primary rows exist.
The token binds its command, the complete normalized query/order contract, a
random library instance identity, the current writer generation, and the next
offset. Changing query text, filters, bounds, limit, or context makes the cursor
query-mismatched. Malformed, wrong-command, and query-mismatched cursors are
invalid usage (exit `2`). A cursor from a recreated library or any later admitted
writer generation—including a no-op index writer—is stale (exit `1`). Cursors
are continuation tokens, not durable bookmarks or public encoded schemas.

## Streams and exit codes

- Stdout: requested human, JSON, JSONL, Markdown, or transcript data.
- Stderr: usage diagnostics, warnings, and operational errors that are not the requested report.
- Exit `0`: success, including an empty result set.
- Exit `1`: operational or capability failure.
- Exit `2`: invalid command, flag, value, or required argument.

Unknown flags and values fail. Color is optional and honors `NO_COLOR`.
Concurrent index/forget/clear ownership is a sanitized
`Session library is busy` operational failure; lease tokens, owners, and timing
details are never rendered.

## Structured output

Every JSON/JSONL command includes a numeric `schemaVersion`. Additive fields may appear within one schema version; removing or changing a field's meaning requires a new version. JSONL starts each record with enough command/type/version information to parse independently.

M6 structured output covers the operational doctor, paths, index, forget, and
data-clear reports documented above. M7 owns versioned list/search/show DTOs,
document digests, and transcript-bearing JSON/JSONL; M6 does not expose a partial
machine schema for those commands.

Planned entry-bearing structured records preserve canonical entry ordinal and
kind plus available exact tool name, exact tool namespace, provider call ID, and
related entry ordinal. Every emitted segment includes its ordinal, kind, origin,
and origin confidence. Text includes its exact value plus canonical content-hash
scheme and digest. Omitted non-text content includes only its broad class and a
1–64-byte lower-ASCII kebab source type matching
`^[a-z0-9]+(?:-[a-z0-9]+)*$`—never bytes, URLs, local paths, placeholder text, or
a hash. The token is a format-declared label, not sanitized arbitrary payload
content. Missing source evidence remains absent or unknown; the DTO does not
assign skill-specific meaning.

Library-backed records also distinguish snapshot freshness from source state and
include the latest successful capture time, source-observation time, adapter
version, and versioned document-digest scheme/value where relevant. A retained
session remains readable and exportable when its source state is `missing` or
`unknown`.

Structured output never mixes progress or warnings into stdout.

## Planned portable export (M7)

`sessions export` will read exactly one retained canonical snapshot and will
never probe or reopen a provider source. Markdown is a self-contained human/agent
context artifact with actor labels, provenance, explicit omission/truncation
markers, and an untrusted-history warning. JSON is one versioned bundle. JSONL
carries the equivalent ordered public projection in independently parseable
records; every record includes enough command, type, schema, session, and
document-digest identity to be attributed without a preceding record.

Every format reports canonical identity, capture time, source state and
observation time, adapter version, document digest, and truncation state. Known
relations are metadata only and do not recursively include other sessions.
Generated metadata excludes entry source locators, input-descriptor locators,
source metadata, provider roots, local workspace paths, and attachment paths.
Faithful title or transcript text is not automatically path- or secret-redacted.

All prior human, model, system, injected, and tool content remains untrusted
historical data. Markdown escapes or structurally contains transcript Markdown
and terminal controls so they cannot alter the generated document structure;
machine formats label the same disposition. Sessions does not import, upload,
paste, call provider APIs, create a destination conversation, manage destination
context limits, or infer transfer lineage from equal text or matching digests.

## Output bounds

Potentially large list, search, and show views are bounded by default. Current
list/search continuation and search body/context truncation are explicit in
human output. M7 export will likewise be bounded: `--full` emits all
export-eligible entries and text from the selected retained normalized snapshot.
It does not reveal hidden reasoning, raw payloads, omitted media contents or
references, private metadata, related-session bodies, or evidence the adapter
never observed. `--full` is never implied by a machine format.
