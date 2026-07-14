# CLI contract

- Status: current M2 behavior plus accepted V1 semantics
- Last updated: 2026-07-13

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
      "summary": "Node.js 26.4.0 satisfies >=24.15.0",
      "details": {
        "version": "26.4.0",
        "minimumVersion": "24.15.0"
      }
    }
  ]
}
```

Check IDs, field names, and `schemaVersion` are machine-facing. Summaries are human-facing. Checks run in declared order and continue after failure. A thrown probe becomes a sanitized failed check.

The current check order is `node-runtime`, `sqlite-fts5`, then `index-state`. The SQLite check reports `sqliteVersion` and `fts5SecureDelete` (`supported` or `unsupported`) in `details`; lack of FTS5 fails the check. The index check passes `uninitialized` with guidance and passes `ready`; every other state fails. Doctor inspection never opens a writer.

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
    "supportedSchemaVersion": 1
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

## Planned identity and filters

Canonical printable IDs use
`<kind>@<percent-encoded-instance-id>:<percent-encoded-native-id>`, for example
`cursor@default:opaque-id`. Kind is an open lowercase adapter slug. Instance and
native IDs are case-sensitive opaque values; delimiters are escaped and values
are never Unicode-normalized. Filters are provider-neutral and may cover
source/source-instance, workspace, time bounds, actor, origin, exact identity,
limit, and continuation cursor. Raw SQLite FTS syntax is not a public API.

## Streams and exit codes

- Stdout: requested human, JSON, JSONL, Markdown, or transcript data.
- Stderr: usage diagnostics, warnings, and operational errors that are not the requested report.
- Exit `0`: success, including an empty result set.
- Exit `1`: operational or capability failure.
- Exit `2`: invalid command, flag, value, or required argument.

Unknown flags and values fail. Color is optional and honors `NO_COLOR`.

## Structured output

Every JSON/JSONL command includes a numeric `schemaVersion`. Additive fields may appear within one schema version; removing or changing a field's meaning requires a new version. JSONL starts each record with enough command/type/version information to parse independently.

Structured output never mixes progress or warnings into stdout.

## Output bounds

Potentially large list, search, show, and export views are bounded by default. Limits and truncation are explicit in output. `--full` opts into unbounded eligible content; it is never implied by a machine format.
