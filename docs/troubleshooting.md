# Troubleshooting

Start with:

```bash
sessions --help
sessions doctor --format json
sessions paths --format json
```

Read doctor checks separately. Its aggregate failure does not always make the
retained library unusable.

## The agent cannot find `sessions`

The Agent Skill does not bundle the CLI. Build or install the CLI first, then
make the `sessions` command available in the agent process and restart that host
if it caches environment variables. Verify with `sessions --help` from the same
environment.

## The library is uninitialized

`list`, cursor-free `search`, and cursor-free `entries` return empty success and
do not create storage. After explicit user authorization, initialize it with:

```bash
sessions index --source codex
```

`show`, `export`, and `forget` still need an existing canonical ID.

## The library is incompatible

Pre-alpha builds recognize one current SQLite baseline and do not upgrade or
delete older development databases. `data clear` also refuses an incompatible
file because it cannot safely claim it.

Use one of these reset paths:

1. Set an absolute fresh `SESSIONS_DATA_DIR`, then index again.
2. Back up and manually remove only the exact obsolete Sessions-owned directory
   reported by `sessions paths`, then index again.

Never remove Codex or other provider directories to reset Sessions.

## The library is busy

Another index, forget, repair, compact, or clear writer owns the library. Let it
finish, then retry. Use doctor to inspect the aggregate writer state. Do not
remove lease or SQLite sidecar files by hand.

## The Codex source is unavailable

Bare indexing skips an unavailable provider, and doctor treats it as
informational; explicit `sessions index --source codex` exits `1`. Retained
snapshots remain available through provider-free queries and export.

A retained session can be `missing` after a complete scan no longer sees it, or
`unknown` when source coverage was incomplete. Its canonical snapshot remains
queryable until explicit deletion.

## Search finds nothing

- Confirm the library is ready and inspect `list` before indexing again.
- Start with short literal terms; Sessions does not accept semantic or raw FTS
  query syntax.
- Use `--match any` only when terms are alternatives.
- Check source, instance, activity, actor, origin, kind, tool, and workspace
  filters for over-narrowing.
- Use `entries` when the evidence is textless or tool-shaped.
- Treat no match as missing evidence, not proof that an event never happened.

## Search is too broad

Add exact filters and a small `--limit`, keep `--context` bounded, then inspect
the best canonical IDs with a focused `show` range. Follow a cursor only when the
next page is required. Search support totals describe the full query, not only
the visible page.

## Evidence is omitted or truncated

Sessions deliberately omits unsupported or sensitive provider fields and bounds
presentation output. Use a focused show/export range first. Use `export --full`
only when the complete retained public snapshot is needed; it still does not
recover raw provider payloads, omitted media, or hidden content. Report the
omission instead of reconstructing it from surrounding claims.

## Deletion and disk size differ

`forget` and `data repair-orphans` remove logical retained content. Freed pages
may stay reusable inside SQLite. Run `sessions data compact` when the user wants
to return reusable whole pages to the filesystem. Compaction does not repack
partly used pages or prove forensic erasure.
