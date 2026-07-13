# CLI contract

- Status: current scaffold plus accepted V1 semantics
- Last updated: 2026-07-13

Generated `sessions --help` owns exact current flags. This document owns behavior and compatibility. Planned commands are not current commands.

## Current commands

```text
sessions
sessions --help
sessions --version
sessions doctor [--format human|json]
```

The bare command prints help. `doctor` performs read-only, in-memory Node.js and SQLite FTS5 checks. It does not index or create persistent state.

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

All-pass and failed-check reports go to stdout. All-pass exits `0`; any failed check exits `1`; both leave stderr empty. Invalid usage writes to stderr and exits `2`. An unexpected failure outside probe aggregation writes a concise stderr diagnostic and exits `1` without fabricating a report.

## Planned V1 commands

```text
sessions index [--source cursor|codex]
sessions list [filters]
sessions search <text> [filters]
sessions show <source-instance:id> [--entry N --context N]
sessions export <source-instance:id> --format md|json|jsonl
sessions paths
sessions index clear
```

These names describe the accepted direction. They are added to generated help only when implemented and contract-tested.

## Planned identity and filters

Canonical printable IDs use `<source-instance>:<native-id>`. Both portions are opaque to callers. Filters are provider-neutral and may cover source/source-instance, workspace, time bounds, actor, origin, exact identity, limit, and continuation cursor. Raw SQLite FTS syntax is not a public API.

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
