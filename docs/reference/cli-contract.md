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

## Planned V1 commands

```text
sessions index [--source cursor|codex]
sessions list [filters]
sessions search <text> [filters]
sessions show <source-instance:id> [--entry N --context N]
sessions export <source-instance:id> --format md|json|jsonl
sessions index clear
```

These names describe the accepted direction. They are added to generated help only when implemented and contract-tested.

M4 implements provider-neutral indexing/reconciliation and clear report values internally, but does not register either route. Generated help remains the authority: `sessions index`, `sessions index clear`, and all query commands are unavailable until later milestones compose their complete user-facing paths.

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
scheme and digest. Omitted non-text content includes only its broad class and
sanitized source type—never bytes, URLs, local paths, placeholder text, or a
hash. Missing source evidence remains absent or unknown; the DTO does not assign
skill-specific meaning.

Structured output never mixes progress or warnings into stdout.

## Output bounds

Potentially large list, search, show, and export views are bounded by default. Limits and truncation are explicit in output. `--full` opts into unbounded eligible content; it is never implied by a machine format.
