# Cursor format support

- Status: current
- Source kind: `cursor`

Sessions passively indexes two local Cursor store families:

| Family                      | Native identity       | Current local source                                      |
| --------------------------- | --------------------- | --------------------------------------------------------- |
| `chat-store-v1`             | Raw chat directory ID | Chat metadata plus its sibling SQLite blob store          |
| `agent-checkpoint-store-v1` | Catalog `agent_id`    | Catalog-selected checkpoint plus its derived SQLite store |

The adapter resolves the default local Cursor root at `$HOME/.cursor` or
`%USERPROFILE%\.cursor`. It reads provider files only after explicit indexing,
copies required SQLite main/WAL bytes into the private Sessions capture
workspace, and never opens or copies provider SHM.

Both families preserve ordered text, reasoning, tool calls, linked tool results,
and documented non-text omissions. Cursor exposes no proven session relations
for these stores, so relations remain empty and lineage coverage remains
`unknown`.

Not supported:

- JSONL-only agent transcripts;
- legacy Composer/App Support history;
- cloud-only history; or
- inferred parent, child, side-chat, or subagent relations.

When only the recognized JSONL layout is present, indexing reports
`unsupported-format`; it does not read those transcript files. Malformed,
conflicting, or changing supported evidence fails closed and never replaces a
last-good retained document.

Use:

```bash
sessions index --source cursor
sessions list --source cursor --native-id '<provider-session-id>'
```

The exact field, path, ordering, authority, and failure matrix is frozen in
[Cursor local format v1 evidence](../research/cursor-format-v1.md).
