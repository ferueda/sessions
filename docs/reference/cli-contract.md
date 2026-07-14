# CLI contract

- Status: current public M4 behavior plus accepted V1 semantics
- Last updated: 2026-07-14

Generated `sessions --help` owns exact current flags. This document owns behavior and compatibility. Planned commands are not current commands.

## Current commands

```text
sessions
sessions --help
sessions --version
sessions doctor [--format human|json]
sessions paths [--format human|json]
```

The bare command prints help. `doctor` performs read-only Node.js, in-memory SQLite FTS5, and existing index-state checks. `paths` reports Sessions-owned index paths and state. Neither command indexes, creates directories, initializes a database, or applies migrations.

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

The current check order is `node-runtime`, `sqlite-fts5`, then `index-state`. The SQLite check reports `sqliteVersion` and `fts5SecureDelete` (`supported` or `unsupported`) in `details`; lack of FTS5 fails the check. The index check passes `uninitialized` with guidance. Every non-ready initialized state fails.

For `ready`, the index check uses an immutable snapshot and adds `integrity`, `foreignKeys`, `ftsStructure`, `ftsContent`, `ftsSecureDelete`, `runRecords`, `writerLease`, `activeRuns`, and `interruptedRuns` to `details`. Health check values are stable strings: checks are `ok` or `failed`; FTS secure delete is `enabled`, `missing`, or `unsupported`; writer lease is `free`, `index-live`, `clear-live`, `expired`, or `invalid`; counts are non-negative decimal strings. `unsupported` is healthy only when the current SQLite runtime lacks the optional persistent setting. Integrity, foreign-key, required FTS configuration, run-record, or lease corruption fails the check. An active run without a live indexing lease also fails. Historical interrupted runs are reported but do not fail by themselves. Unexpected health inspection failure is sanitized as `health: inspection-failed`. Doctor inspection never opens a writer, runs migrations, or uses the write-shaped FTS integrity command.

All-pass and failed-check reports go to stdout. All-pass exits `0`; any failed check exits `1`; both leave stderr empty. Invalid usage writes to stderr and exits `2`. An unexpected failure outside probe aggregation writes a concise stderr diagnostic and exits `1` without fabricating a report.

### Paths JSON

`sessions paths --format json` writes one JSON document. Before initialization, a Linux default may look like:

```json
{
  "schemaVersion": 1,
  "command": "paths",
  "index": {
    "directory": "/home/user/.cache/sessions",
    "database": "/home/user/.cache/sessions/index.sqlite3",
    "wal": "/home/user/.cache/sessions/index.sqlite3-wal",
    "shm": "/home/user/.cache/sessions/index.sqlite3-shm",
    "initialized": false,
    "state": "uninitialized",
    "schemaVersion": null,
    "supportedSchemaVersion": 3
  }
}
```

Version 1 reports only the Sessions-owned index directory, database, known WAL/SHM paths, initialization flag, state, observed schema version, and supported schema version. It does not report provider roots because no adapters are registered. Current state values are `uninitialized`, `ready`, `migration-required`, `newer-schema`, `incompatible`, `recovery-required`, and `unsafe`.

The human format presents the same fields. A successfully inspected incompatible state is still a paths report and exits `0`; doctor is the command that evaluates health. Path resolution or inspection failures emit no partial report, write a concise diagnostic to stderr, and exit `1`.

M5 replaces this pre-public cache report with a schema-versioned durable-library
report rooted in platform application data and the `SESSIONS_DATA_DIR` override.
It uses `library`, not `index`, for the owned database fields and does not silently
change schema version 1 or reuse the old cache location.

## Planned V1 commands

```text
sessions index [--source cursor|codex] [--format human|json]
sessions list [filters]
sessions search <text> [filters]
sessions show <source-instance:id> [--entry N --context N]
sessions export <source-instance:id> --format md|json|jsonl [--full]
sessions forget <source-instance:id> [--format human|json]
sessions data clear --yes [--format human|json]
```

These names describe the accepted direction. They are added to generated help only when implemented and contract-tested.

M4 implements provider-neutral indexing/reconciliation and whole-database clear values internally, but does not register either route. M5 adapts those internals to durable capture before exposure. Generated help remains the authority: `sessions index`, `sessions forget`, `sessions data clear`, and all query commands are unavailable until their complete user-facing paths are composed.

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
state is a different, non-destructive
operation and is not a public M5 command.

On a fresh uninitialized library, `sessions list` exits `0`, writes exactly
`No sessions found.` plus a newline to stdout, leaves stderr empty, and returns the
logical result `{ sessions: [], truncated: false }`. It does not create storage,
run migrations, open a reader, or resolve/probe an adapter. Initialized-but-empty
uses the same output through a normal read snapshot. Other initialized non-ready
states remain operational failures. `show` of an absent identity, including in an
uninitialized library, remains a sanitized not-found operational failure.

### M5 operational JSON

M5's first public operational reports are stable contracts. Transcript-bearing
list/show output remains human-only until the M7 DTO work.

`sessions index --format json` emits schema 2 because missing/coverage supersede
the internal pre-public schema-1 meaning. A complete representative report
is:

```json
{
  "schemaVersion": 2,
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
      "schemaVersion": 2,
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
`interrupted`, or `repository-write`. New reports never emit the legacy
schema-3 `removed` count/outcome. Source reports sort by raw source tuple; items
retain persisted run-item order. Top counts and omissions are safe sums.

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

M5 paths schema 2 replaces `index` with `library` and adds admitted source probes:

```json
{
  "schemaVersion": 2,
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
    "supportedSchemaVersion": 4
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

Doctor schema 2 keeps `{ schemaVersion, command: "doctor", ok, checks }` and each
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

## Planned identity and filters

Canonical printable IDs use
`<kind>@<percent-encoded-instance-id>:<percent-encoded-native-id>`, for example
`cursor@default:opaque-id`. Kind is an open lowercase adapter slug. Instance and
native IDs are case-sensitive opaque values; delimiters are escaped and values
are never Unicode-normalized. Filters are provider-neutral and may cover
source/source-instance, workspace, time bounds, actor, origin, exact entry kind,
exact source-observed tool name, exact source-observed tool namespace, exact
session identity, limit, and continuation cursor. Tool-name and namespace
filters match separate, case-sensitive recorded fields and combine with logical
AND. A call with no namespace never matches a namespace filter. They do not infer
that a named skill or workflow ran. They select canonical tool-call entries only;
bounded context may include directly linked tool-result entries without copying
tool identity onto them. Raw SQLite FTS syntax is not a public API.

## Streams and exit codes

- Stdout: requested human, JSON, JSONL, Markdown, or transcript data.
- Stderr: usage diagnostics, warnings, and operational errors that are not the requested report.
- Exit `0`: success, including an empty result set.
- Exit `1`: operational or capability failure.
- Exit `2`: invalid command, flag, value, or required argument.

Unknown flags and values fail. Color is optional and honors `NO_COLOR`.

## Structured output

Every JSON/JSONL command includes a numeric `schemaVersion`. Additive fields may appear within one schema version; removing or changing a field's meaning requires a new version. JSONL starts each record with enough command/type/version information to parse independently.

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

## Portable export

`sessions export` reads exactly one retained canonical snapshot and never probes
or reopens a provider source. Markdown is a self-contained human/agent context
artifact with actor labels, provenance, explicit omission/truncation markers,
and an untrusted-history warning. JSON is one versioned bundle. JSONL carries the
equivalent ordered public projection in independently parseable records; every
record includes enough command, type, schema, session, and document-digest
identity to be attributed without a preceding record.

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

Potentially large list, search, show, and export views are bounded by default. Limits and truncation are explicit in output. For export, `--full` emits all export-eligible entries and text from the selected retained normalized snapshot. It does not reveal hidden reasoning, raw payloads, omitted media contents or references, private metadata, related-session bodies, or evidence the adapter never observed. `--full` is never implied by a machine format.
