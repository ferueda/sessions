# CLI contract

- Status: current behavior plus accepted later-V1 semantics
- Last updated: 2026-07-17

Generated `sessions --help` owns exact current flags. This document owns behavior
and compatibility. Planned commands are labeled explicitly.

Development schemas may reset before supported `0.1.0`. The unsupported `0.0.0`
bootstrap seed establishes no CLI contract. Compatibility begins with the
`0.1.0` CLI; no earlier development contract is supported.

## Current commands

```text
sessions
sessions --help
sessions --version
sessions doctor [--format human|json]
sessions paths [--format human|json]
sessions index [--source codex|cursor] [--format human|json]
sessions list [--source SOURCE] [--instance INSTANCE]
              [--native-id NATIVE-ID]
              [--source-state present|missing|unknown] [--workspace WORKSPACE]
              [--activity-after TIME] [--activity-before TIME]
              [--captured-after TIME] [--captured-before TIME]
              [--observed-after TIME] [--observed-before TIME]
              [--session CANONICAL-ID] [--limit N] [--cursor TOKEN]
              [--format human|json|jsonl]
sessions search <text> [--source SOURCE] [--instance INSTANCE]
                       [--match all|any]
                       [--native-id NATIVE-ID]
                       [--source-state present|missing|unknown]
                       [--workspace WORKSPACE]
                       [--activity-after TIME] [--activity-before TIME]
                       [--captured-after TIME] [--captured-before TIME]
                       [--observed-after TIME] [--observed-before TIME]
                       [--session CANONICAL-ID]
                       [--entry-after TIME] [--entry-before TIME]
                       [--actor ACTOR] [--origin ORIGIN] [--kind KIND]
                       [--tool-name NAME] [--tool-namespace NAMESPACE]
                       [--limit N] [--context N] [--cursor TOKEN]
                       [--format human|json|jsonl]
sessions entries [--source SOURCE] [--instance INSTANCE]
                 [--native-id NATIVE-ID]
                 [--source-state present|missing|unknown]
                 [--workspace WORKSPACE]
                 [--activity-after TIME] [--activity-before TIME]
                 [--captured-after TIME] [--captured-before TIME]
                 [--observed-after TIME] [--observed-before TIME]
                 [--session CANONICAL-ID]
                 [--entry-after TIME] [--entry-before TIME]
                 [--actor ACTOR] [--origin ORIGIN] [--kind KIND]
                 [--tool-name NAME] [--tool-namespace NAMESPACE]
                 [--select all|first|last]
                 [--limit N] [--cursor TOKEN]
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

The bare command prints help. `index` is the only ordinary command that reads
rollout content or initializes the durable library. `forget` mutates only a
current initialized library. `data repair-orphans` and `data compact` are
provider-free maintenance over an existing current library; neither resolves a
source. List, search, entries, show, and export are provider-free reads of the retained
library. `doctor` and `paths` inspect runtime, library, and registered-source
readiness without indexing or creating state.

Without `--source`, `index` skips valid unavailable providers before writer open
and attempts the rest. If all are skipped, it exits `0` without creating the
library. Unreadable, invalid, or throwing probes fail. Explicitly selecting an
unavailable provider exits `1`; an unknown source is usage exit `2`. Any
incomplete attempted source exits `1`; otherwise indexing exits `0`. Successful
captures remain durable, complete later absence marks a session missing, and
incomplete discovery leaves source state unknown.

`list` defaults to 50 and accepts 1 through 200. Activity is
`updatedAt`, falling back to `createdAt`; missing activity sorts last, then
activity descends, then the raw source/instance/native tuple ascends with binary
collation. When another page exists, output ends with the copyable
`Next cursor: <token>` line. A fresh library renders `No sessions found.`, then
the uninitialized-capture warning described below, exits `0`, and does not create
state or resolve a provider. JSON emits an empty page bundle; JSONL emits one page record.
Every non-empty result includes one query-derived known retained root or
`unknown`.

`search` requires non-blank text, defaults to `--match all` and 20 primary hits,
and accepts 1 through 200. `--context` defaults to 0 and accepts 0 through 10
adjacent entries on each side. A no-match result renders `No matches found.`,
then a capture warning when the page scope is not complete, and exits `0`.
Search, list, entries, and show read one immutable retained-library
snapshot per operation and never resolve or reopen a provider. JSON emits an empty
page bundle; JSONL emits one page record.

`entries` requires no search text. It defaults to `--select all` and 50 records,
and accepts 1 through 200. `all` returns every qualifying entry. `first` and
`last` return the minimum or maximum canonical entry ordinal per session after
all filters are applied. Every mode orders by binary source kind, source
instance, native ID, then entry ordinal ascending; timestamps never reorder
evidence. A fresh library renders `No entries found.`, then the
uninitialized-capture warning, exits `0`, and creates no state or provider
object. JSON emits an empty page; JSONL emits one page record.

`show` defaults to the first 50 entries. `--entry N` focuses one entry with 3
entries of context on each side by default; `--context` accepts 0 through 100 and
requires `--entry`. `--from-entry N` and `--to-entry N` select both inclusive
endpoints and must be supplied together. A range contains at most 200 entries and
cannot combine with `--entry` or `--context`. Missing session/entry values,
including either range endpoint outside the retained document, are operational
failures; ranges are never clamped.
Incomplete, reversed, oversized, or conflicting ranges exit `2` before library
inspection.
List/search/entries/show default to human and accept JSON or JSONL. Human output escapes
and bounds untrusted terminal content. Machine output uses the exact closed
schema-1 records in the
[structured output contract](structured-output.md). All formats report
applicable freshness/source-state/capture evidence and omit diagnostic locators
and workspace metadata.

`export` requires an explicit JSON or JSONL format and reads one retained
canonical snapshot. Default export is bounded; `--full` removes presentation
bounds and the aggregate encoded-output cap only for export-eligible fields in
that snapshot. Export accepts the same paired inclusive range and 200-entry
maximum, but a range cannot combine with `--full`. Export never resolves a
provider or follows relations.

`forget` idempotently deletes one retained Sessions copy and returns `forgotten`
or `absent`. `data repair-orphans` requires no confirmation and deletes only
canonical content that no retained occurrence reaches. `data compact` requires
no confirmation and reclaims reusable whole SQLite pages without deleting
retained rows. `data clear` requires `--yes` and deletes all known Sessions-owned
state. All leave provider data untouched.

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

The current check order is `node-runtime`, `sqlite-fts5`, `library-state`,
`source-codex`, then `source-cursor`. The SQLite check reports `sqliteVersion` and `fts5SecureDelete`
(`supported` or `unsupported`) in `details`; lack of FTS5 fails. An uninitialized
library passes. Every non-ready initialized state fails.

For `ready`, the library check uses an immutable snapshot and adds
`canonicalIntegrity`, `foreignKeys`, `contentReachability`,
`orphanContentRows`, `orphanContentBytes`, `ftsStructure`, `ftsContent`,
`ftsSecureDelete`, `ftsRemediation`, `pageReclamation`, `runRecords`,
`writerLease`, `activeRuns`, `interruptedRuns`, and the capture details described
below to `details`. Checks are
`ok | failed`; content reachability is `ok | orphaned | inspection-failed`;
orphan counts are exact non-negative decimal strings, or `unknown` when
inspection fails. Page reclamation is `incremental | invalid`; FTS secure delete
is `enabled | missing | unsupported`; remediation is
`not-needed | rebuild-required`; writer lease is `free | index-live |
forget-live | repair-live | compact-live | clear-live | expired | invalid`;
remaining counts are non-negative decimal strings. Canonical, foreign-key,
content-reachability, or run corruption fails. FTS-only damage reports
rebuild-required without describing canonical loss. An active run is healthy
only with an index-live lease. `ftsContent` compares exact retained terms,
positions, and docsize with a contentless TEMP FTS index built from canonical
rows in bounded batches. The temporary index is memory-only. Doctor never opens
a writer or applies migrations.

The ready-library capture details are exactly `captureStatus`,
`trackedSessions`, `retainedCurrentSessions`, `retainedStaleSessions`,
`unindexedSessions`, `sourceStatePresentSessions`,
`sourceStateMissingSessions`, `sourceStateUnknownSessions`,
`sourceCoverageComplete`, `sourceCoverageUnknown`,
`latestFailureUnavailable`, `latestFailureUnreadable`,
`latestFailureMalformed`, `latestFailureSourceChanged`,
`latestFailureUnsupportedFormat`, and `latestFailureRepositoryWrite`.
`captureStatus` is `complete | incomplete | inspection-failed`; every other
capture detail is a non-negative decimal string, or `unknown` when capture
inspection fails. An incomplete scope keeps the library check healthy and uses
the summary `Index schema N is ready; evidence may be incomplete`. A capture
inspection failure fails the check. Any failed health condition keeps the
existing `Index schema N failed health checks` summary instead of the incomplete
warning.

All-pass and failed-check reports go to stdout. All-pass exits `0`; any failed check exits `1`; both leave stderr empty. Invalid usage writes to stderr and exits `2`. An unexpected failure outside probe aggregation writes a concise stderr diagnostic and exits `1` without fabricating a report.

### Paths JSON

`sessions paths --format json` writes one schema-1 document. The exact schema and
example are in Current machine-readable contracts below.

Schema 1 reports the Sessions-owned application-data library, scratch workspace,
known database/sidecar paths, state, schema support, and admitted source probes.
Current state values are `uninitialized`, `ready`, `migration-required`,
`newer-schema`, `incompatible`, `recovery-required`, and `unsafe`.

The human format presents the same fields. An incompatible state is still a paths
report and exits `0`; doctor evaluates health. Resolution/inspection failure emits
no partial report and exits `1`. A pre-release migration-checksum mismatch fails
closed with recovery guidance: select a fresh `SESSIONS_DATA_DIR`, or back up and
remove only the obsolete Sessions-owned directory reported by `sessions paths`,
then index again. `data clear` does not claim that incompatible database.

Markdown is deferred beyond V1 and `--format md` is not accepted today. Planned
routes are added to generated help only when implemented and contract-tested.

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
session, a later explicit index can capture it again. Doctor reports exact
aggregate canonical content reachability. `sessions data repair-orphans` is the
explicit provider-free route for deleting content that no retained occurrence
reaches. It scans to completion through fixed internal committed batches under a
dedicated repair lease and reports deleted row and logical UTF-8 payload totals.
The command has no public limit, cursor, partial result, or progress contract. A
failed invocation emits no success report; already committed batches remain
durable and a fresh invocation safely restarts. A later doctor can verify that
reachability is healthy.

Against an absent library, orphan repair returns `unchanged` with zero totals,
creates no storage, and does not resolve a provider.

`sessions data clear` requires `--yes` and removes only the known Sessions
library database/WAL/SHM files plus the exact ephemeral scratch subtree.
Rebuilding derived FTS/query state is a different, non-destructive operation and
is not a public command. An explicit leased `index` writer verifies the canonical
library first and repairs FTS-only structure/content damage from canonical
content. Doctor remains read-only and reports `rebuild-required`; canonical
corruption fails closed instead of invoking projection repair. Orphan repair
never rebuilds FTS and fails closed when a candidate lacks its expected derived
FTS row.

Index lease acquisition marks its generation dirty. A normal index close may
seal and release only that exact generation, then publishes a private
database-stat-bound post-close proof after database cleanup succeeds. A matching
clean seal and proof allow the next ready, sidecar-free, current-schema writer to
use constant-size schema/FTS structure checks plus proportional changed-document
verification. Recovery, migration, maintenance, failed cleanup, or rejected
proof uses full canonical, foreign-key, and FTS validation/repair. This is an
internal performance path: it adds no CLI flag, output field, or exit code.
Direct SQLite edits outside Sessions are unsupported.

Forget is logical deletion: freed whole pages become reusable, but the command
does not promise that the main database file shrinks. `sessions data compact`
is the separate physical maintenance route. It checkpoints WAL and runs bounded
incremental-vacuum transactions until the current freelist is empty. Every
committed batch is durable; a later failure emits no success report and rerunning
is safe. It reclaims whole free pages only, never repacks partially used pages,
and reports observed main-database file lengths rather than guaranteed savings.

On a fresh uninitialized library, `sessions list`, cursor-free `sessions search`,
and cursor-free `sessions entries` exit `0`, write their format-specific empty result to stdout,
and leave stderr empty. Human writes the normal empty-result line, a blank line,
and exactly `Warning: retained evidence may be incomplete (capture scope is uninitialized).`;
JSON uses an empty page bundle with `captureScope`; JSONL uses one page record
with `captureScope`. They do not create storage, run
migrations, open a reader, or resolve/probe an adapter. Initialized-but-empty
uses the same output through a normal read snapshot. A supplied cursor against
absent/recreated state is stale. Other initialized non-ready states remain
operational failures. `show` and `export` of an absent identity, including in an
uninitialized library, remain sanitized not-found operational failures.

## Current operational JSON

The current pre-alpha operational reports are exact test-backed contracts. The
separate [structured output contract](structured-output.md) owns
transcript-bearing list/search/entries/show/export JSON and JSONL.

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
  "skippedSources": 0,
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
`interrupted`, or `repository-write`. An implicitly unavailable source is
`skipped` with `reason: "source-unavailable"`, zero counts/items,
`coverage: { "status": "not-attempted" }`, and observed start/finish timestamps.
`skippedSources` counts skipped sources; `incompleteSources` counts attempted
failures. Source reports sort by raw source tuple; items retain persisted
run-item order. Top counts and omissions are safe sums.

Forget, orphan repair, physical compaction, and all-data deletion emit these
exact schema-1 shapes:

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
  "command": "data-repair-orphans",
  "outcome": "repaired",
  "deletedContentRows": "2",
  "deletedContentBytes": "1536"
}
```

`outcome` is `repaired | unchanged`. Unchanged reports both aggregate values as
the exact string `"0"`; repaired reports a positive deleted-row count. Both
values are canonical non-negative decimal strings so totals are not constrained
by JavaScript safe integers. `deletedContentBytes` is the exact logical UTF-8
payload of deleted canonical text, not database length, filesystem allocation,
or reclaimed storage. Human output reports the same aggregates. The command
processes fixed internal batches to completion and exposes no public limit,
cursor, partial outcome, or progress token. Failure emits no report; a fresh
invocation safely resumes from remaining canonical state.

```json
{
  "schemaVersion": 1,
  "command": "data-compact",
  "outcome": "compacted",
  "databaseBytesBefore": 8192,
  "databaseBytesAfter": 4096,
  "reclaimedDatabaseBytes": 4096
}
```

`outcome` is `absent | unchanged | compacted`. Absent reports three zeroes;
unchanged reports equal before/after values and zero reclaimed bytes. The values
are exact non-negative safe-integer main-database file lengths observed after
required checkpoints. They are not page estimates, filesystem block allocation,
or a guaranteed amount. Human output reports the same aggregates without paths.

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
    },
    {
      "source": {
        "kind": "cursor",
        "instanceId": "local-sha256-v1:1111111111111111111111111111111111111111111111111111111111111111"
      },
      "probe": {
        "status": "ready",
        "locations": [{ "role": "cursor-home", "uri": "file:///home/user/.cursor" }]
      }
    }
  ]
}
```

Library state values remain `uninitialized`, `ready`, `migration-required`,
`newer-schema`, `incompatible`, `recovery-required`, and `unsafe`. An admitted
probe status is `ready | unavailable | unreadable`; sources sort by raw identity
tuple. Locations retain their adapter-declared order. A malformed/thrown probe becomes
`{ "status": "failed", "failure": "invalid-probe" | "probe-error", "locations": [] }`
without failing paths. Failure before a stable source identity exists, or library
inspection failure, emits no partial report and exits `1`.

Doctor schema 1 uses `{ schemaVersion, command: "doctor", ok, checks }` and each
`{ id, label, ok, summary, details }` check. Check order is `node-runtime`,
`sqlite-fts5`, `library-state`, `source-codex`, `source-cursor`. The ready `library-state` string
details are exactly `state`, `initialized`, `schemaVersion`,
`supportedSchemaVersion`, `canonicalIntegrity`, `foreignKeys`,
`contentReachability`, `orphanContentRows`, `orphanContentBytes`, `ftsStructure`,
`ftsContent`, `ftsSecureDelete`, `ftsRemediation`, `pageReclamation`, `runRecords`,
`writerLease`, `activeRuns`, `interruptedRuns`, `captureStatus`,
`trackedSessions`, `retainedCurrentSessions`, `retainedStaleSessions`,
`unindexedSessions`, `sourceStatePresentSessions`,
`sourceStateMissingSessions`, `sourceStateUnknownSessions`,
`sourceCoverageComplete`, `sourceCoverageUnknown`,
`latestFailureUnavailable`, `latestFailureUnreadable`,
`latestFailureMalformed`, `latestFailureSourceChanged`,
`latestFailureUnsupportedFormat`, and `latestFailureRepositoryWrite`; non-ready
states retain the first four and add only applicable `reason`/`target`.
`canonicalIntegrity`,
foreign-key, FTS structure/content, and run-record values are `ok | failed`;
content reachability is `ok | orphaned | inspection-failed`; orphan rows and
logical UTF-8 bytes are exact decimal strings, or `unknown` after an inspection
failure. FTS secure-delete is `enabled | missing | unsupported`; FTS remediation
is `not-needed | rebuild-required`; writer-lease values are `free`, `index-live`,
`forget-live`, `repair-live`, `compact-live`, `clear-live`, `expired`, or
`invalid`. Ready-library capture values follow the health and warning semantics
defined in Doctor JSON above.

An admitted `source-codex` or `source-cursor` check has only `probeStatus` with value
`ready | unavailable | unreadable`. Ready and optional unavailable pass;
unreadable fails. A malformed or thrown probe fails with exactly
`{ "probeStatus": "failed", "failure": "invalid-probe" | "probe-error" }`.
Doctor never duplicates the roots owned by paths. Summaries and labels are
human-facing; IDs, order, detail keys/values, and schema version are
machine-facing.

Pre-alpha schema 1 has one current checksum that includes the writer clean-seal
state. There is no compatibility migration from earlier development checksums;
they fail closed and require the documented fresh data-directory or exact
Sessions-owned-directory reset and reindex.

## Current query contract

Canonical printable IDs use
`<kind>@<percent-encoded-instance-id>:<percent-encoded-native-id>`, for example
`codex@default:opaque-id`. Kind is an open lowercase adapter slug. Instance and
native IDs are case-sensitive opaque values; delimiters are escaped and values
are never Unicode-normalized.

### Shared session filters

Each filter accepts one value; different filters combine with AND. Exact values
use their case-sensitive canonical representation:

- `--source` selects an exact source kind. `--instance` selects an exact source
  instance and requires `--source`.
- `--native-id` selects an exact provider-native session ID. It can be used
  alone and can return multiple retained canonical sessions because native IDs
  are unique only within a source instance. `--source` and `--instance` narrow
  the match.
- `--source-state` accepts `present`, `missing`, or `unknown`.
- `--workspace` selects the exact retained workspace value.
- `--activity-after` / `--activity-before` bound effective provider activity.
- `--captured-after` / `--captured-before` bound successful capture time.
- `--observed-after` / `--observed-before` bound effective source-observation
  time.
- `--session` selects one exact canonical identity. Combining it with
  `--native-id` uses the same AND rule; contradictory identities return an empty
  successful result.

Native IDs are non-empty, case-sensitive opaque values. Sessions does not parse,
normalize, prefix-match, or send them through transcript FTS. List results expose
the canonical identity required by `show`, `export`, and `forget`; those singular
or destructive commands do not auto-resolve native IDs across source instances.

Times must be canonical UTC with milliseconds, such as
`2026-07-14T12:00:00.000Z`. Every `after`/`before` bound is exclusive; equal or
inverted pairs are invalid usage. A missing timestamp does not satisfy either
bound.

Effective provider activity is `updatedAt`, falling back to `createdAt` only
when `updatedAt` is absent. A session missing both does not match an activity
bound. Capture, source-observation, and entry time are never substituted.

Effective source state is `unknown` while the source instance's latest coverage
is unknown; otherwise it is that retained session's `present`/`missing` tracking
state. Effective source-observation time follows the same evidence boundary: use
the source coverage observation while coverage is unknown, otherwise use the
session presence observation. `lastSeenAt`, capture time, and provider activity
time are never substituted.

### Page capture scope

Every list, search, and entries result carries one page-level `captureScope`.
The query rows and this aggregate are read from the same retained-library
snapshot. It measures what Sessions has captured or failed to capture; it is not
another result count and contains no session identities, filter values, paths,
workspace values, transcript text, or other private fields.

`status` is `uninitialized` for an absent library. In an initialized library it
is `complete` only when at least one applicable registered source exists, all
applicable source coverage is complete, and every assessed tracked session has
a current canonical snapshot. Every other initialized scope is `incomplete`.
The count partitions are exact:

- `trackedSessions` equals `retainedSessions.current + retainedSessions.stale +
unindexedSessions`;
- `trackedSessions` also equals `sourceState.present + sourceState.missing +
sourceState.unknown`; and
- `retainedSessions.stale + unindexedSessions` equals the sum of the six
  `latestFailures` counts.

Source state uses the effective coverage boundary described above. A first-seen
failure is counted as unindexed even when its retained tracking presence is
missing. Source coverage counts registered source instances, not sessions.
Latest failures use `unavailable`, `unreadable`, `malformed`, `sourceChanged`,
`unsupportedFormat`, and `repositoryWrite`.

Capture aggregation can apply exact source, instance, native-ID, source-state,
and canonical-session filters to tracking evidence. Their structured names are
`source`, `instance`, `nativeId`, `sourceState`, and `session`. Active workspace,
activity/capture/observation time, entry time, actor, origin, entry-kind, tool,
and search-text filters are listed in `unassessedFilters`; Sessions does not
classify an unindexed session as matching or not matching canonical content it
does not have. `appliedFilters` and `unassessedFilters` use one fixed canonical
order and report names only. Search text is therefore always unassessed, even
though it remains active for selecting search hits.

Human output is silent for a complete scope. An incomplete or uninitialized
scope appends one sanitized warning after the normal result, including empty
results. JSON includes the aggregate once in the page bundle; JSONL includes it
once in the page record and never repeats it on session, hit, or entry records.
Search `support` remains query-wide evidence about matching retained text.
`captureScope` instead describes capture availability, so zero hits never by
itself proves that the providers contain no matching evidence.

### Entry filters

Search and entries share exact entry filters:

- exclusive `--entry-after` / `--entry-before` canonical entry timestamps;
- exact `--actor` values `human`, `model`, `tool`, `system`, or `unknown`;
- exact `--origin` values `human`, `injected`, `delegated`, `replayed-copied`,
  `model`, `tool`, `system`, or `unknown`;
- exact `--kind`, `--tool-name`, and `--tool-namespace` values.

Entry time, actor, kind, and tool fields apply to the canonical entry. Tool name
and namespace combine with AND and select observed `tool-call` entries only. A
call without a namespace does not match a namespace filter. Text mentions,
injected catalogs, and agent claims never manufacture a call or prove a named
skill or workflow ran.

Origin applies to canonical segments. For entries, any matching segment qualifies,
including an omitted segment; an empty entry does not. Search requires a matching
text occurrence, so omitted content cannot be a primary search match. All exact
filters combine with AND.

### Entry inventory

`sessions entries` selects entry structure without a text predicate or FTS. The
selection is applied after every session and entry filter. `first` and `last`
choose the lowest or highest qualifying canonical ordinal in each session, not
the earliest or latest timestamp.

Each result includes its retained session summary, exact entry coordinate and
observed tool/linkage fields, exact text and omitted-segment counts, one optional
preview, and root attribution. Without `--origin`, the lowest-ordinal text
segment supplies the preview. With `--origin`, only the lowest-ordinal matching
text segment can supply it. If only omitted content matches, the result has no
preview rather than showing unrelated text. A preview is bounded to 512 UTF-8
bytes and keeps the full text content hash. The unpreviewed count is the number
of retained text segments not represented by that one preview.

Root attribution is either one known retained session reference or `unknown`,
using the lineage rules below. It is query-derived evidence only and does not
change canonical documents, document digests, exports, filters, or ordering.
Human output prints the escaped session/entry heading, root, preview or
`(no text preview)`, content counts, and any next cursor.

### Search text, filters, and hits

Search splits well-formed input on Unicode whitespace, joins it with single
spaces, and admits at most 32 terms and 4,096 UTF-8 bytes of that canonical text.
It quotes every term as literal FTS data. `--match all` is the default and joins
terms with logical AND; `--match any` joins them with logical OR. Quotes, FTS
keywords, paths, opaque IDs, operators, and punctuation are never interpreted as
public FTS syntax. CLI argument parsing happens first: use
`sessions search -- "-term"`
when search text begins with a dash. Without the delimiter, a leading-dash token
is an unknown option and invalid usage. Blank input is invalid usage. Non-blank
input that yields no tokens under the fixed FTS5 `unicode61` tokenizer succeeds with no matches.
Lexical case/diacritic behavior follows that tokenizer; it is distinct from the
case-sensitive exact filters below.

Filters constrain the primary matching occurrence/entry; returned context need
not satisfy them. Origin applies to the matching text occurrence.

Every hit reports `matchedTerms` in first-query order, with exact unique query
terms that matched an eligible text occurrence in that entry. An origin filter
also constrains this evidence. Matched terms are derived from candidate-local
term checks, never parsed from the snippet. In `all` mode they are the query's
unique terms.

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

List results, search hits, and entry inventory records each expose that same
query-derived known root or `unknown`. Attribution can point to a retained root
outside the current filters. It does not change filtering, ranking, ordering,
canonical documents, document digests, show, or export.

### Continuation cursors

List, search, and entries expose an opaque next cursor only when more primary rows exist.
The token binds its command, the complete normalized query/order contract, a
random library instance identity, the current writer generation, and the next
offset. Changing query text, term mode, filters, bounds, limit, or context makes the cursor
query-mismatched. Malformed, wrong-command, and query-mismatched cursors are
invalid usage (exit `2`). A cursor from a recreated library or any later admitted
writer generation—including a no-op index writer—is stale (exit `1`). Cursors
are continuation tokens, not durable bookmarks or public encoded schemas.

## Streams and exit codes

- Stdout: requested human, JSON, JSONL, or transcript data.
- Stderr: usage diagnostics, warnings, and operational errors that are not the requested report.
- Exit `0`: success, including an empty result set.
- Exit `1`: operational or capability failure.
- Exit `2`: invalid command, flag, value, or required argument.

`sessions index`, `sessions data repair-orphans`, and `sessions data compact`
write one startup notice to interactive stderr warning that the operation may
take a couple of minutes. Redirected or captured stderr remains quiet on
success. This is expectation-setting only: it exposes no percentage, elapsed
time, work total, ETA, cursor, partial outcome, or machine-readable progress
contract.

The contributor diagnostic `SESSIONS_INDEX_TIMINGS=1 sessions index ...` is the
only exception to quiet redirected stderr on successful indexing. It adds one
prefixed aggregate JSON timing record to stderr after the operation while
leaving stdout, the index report, and the exit code unchanged. It is not a
versioned public DTO or progress contract and contains only fixed phase names,
call counts, and elapsed milliseconds. Other values and commands ignore the
switch.

Unknown flags and values fail. Color is optional and honors `NO_COLOR`.
Concurrent index/forget/repair/compact/clear ownership is a sanitized
`Session library is busy` operational failure; lease tokens, owners, and timing
details are never rendered.

## Structured output and portable export

Every list/search/entries/show/export JSON/JSONL record has numeric `schemaVersion: 1`, a
command, a record type, and `disposition: "untrusted-history"`. JSON is one
bundle. JSONL is an ordered set of compact, independently attributable records. The exact closed DTOs,
optional/null rules, record order, UTF-8 selection accounting, examples, and
16 MiB fail-before-output limit are in the
[structured output contract](structured-output.md).

Entry-bearing records preserve canonical coordinates, available exact
tool/linkage values, segment provenance, and full canonical content hashes.
Omitted non-text values include only their admitted broad class and canonical
source-type token—never payload bytes, URLs, local paths, placeholder text, or a
hash. Library records distinguish freshness from source state and include the
latest successful capture, source observation, last-good adapter version, and
document digest.

JSON/JSONL never mixes progress or warnings into stdout. The complete encoded
result is validated before the first write. Every bounded machine result at or
below 16 MiB succeeds; one byte over exits `1` with no stdout. List/search/entries can be
narrowed. Show is always bounded. Default export is bounded, while explicit
`export --full` is the sole structured route exempt from the aggregate cap.

Show/export ranges choose an exact contiguous entry window before the existing
segment/text bounds run. Therefore selected entries can still report omitted
segments or truncated text. Range selection does not alter the complete-document
digest. The current reader reconstructs and validates the complete retained
document before selecting the requested window; ranges bound returned evidence,
not SQLite read cost.

Export reads exactly one retained canonical snapshot and never probes or reopens
a provider source. Known relations are metadata only and do not recursively
include other session bodies. Generated metadata excludes source/input locators,
source metadata, provider roots, workspace, and attachment paths. Faithful title
or transcript text is not automatically path- or secret-redacted. Sessions does
not import, upload, paste, call provider APIs, create a destination conversation,
manage destination context limits, or infer transfer lineage from equal text or
matching digests.

Markdown remains deferred post-V1 presentation work. It is not a current format
and any later design may not change the eligible evidence or document-digest
semantics defined by JSON/JSONL.
