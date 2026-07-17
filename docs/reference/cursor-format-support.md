# Cursor format support

- Status: current
- Source kind: `cursor`

Sessions passively indexes three local Cursor families:

| Family                      | Native identity            | Current local source                                      |
| --------------------------- | -------------------------- | --------------------------------------------------------- |
| `chat-store-v1`             | Raw chat directory ID      | Chat metadata plus its sibling SQLite blob store          |
| `agent-checkpoint-store-v1` | Catalog `agent_id`         | Catalog-selected checkpoint plus its derived SQLite store |
| `agent-transcript-jsonl-v1` | Unique transcript basename | Recognized local agent-transcript JSONL                   |

The adapter resolves the default local Cursor root at `$HOME/.cursor` or
`%USERPROFILE%\.cursor`. It reads provider files only after explicit indexing,
copies required SQLite main/WAL bytes into the private Sessions capture
workspace, and never opens or copies provider SHM.

The store-backed families preserve ordered text, reasoning, tool calls, linked
tool results, and documented non-text omissions. A JSONL fallback preserves only
ordered user/model text, tool calls, and turn-end lifecycle evidence. It has no
title, workspace, timestamps, tool results, call IDs, result linkage, or proven
relations. Missing fields are unknown evidence, not proof they never existed.

Not supported:

- legacy Composer/App Support history;
- cloud-only history; or
- inferred parent, child, side-chat, or subagent relations.

Rich store evidence wins over same-ID JSONL and excludes that JSONL from the rich
fingerprint. An explicit `hasConversation: false` record also suppresses same-ID
fallback. A unique otherwise-unowned JSONL basename is its provider-native ID.
Several files with the same unowned basename produce one deterministic
`unsupported-format` candidate; Sessions never chooses, merges, or invents
project-scoped IDs.

A reduced JSONL candidate may be replaced by later rich evidence. A reduced
candidate never replaces retained rich evidence; the failed refresh stays
visible and the rich last-good snapshot remains queryable. Malformed or changing
input also fails closed.

Use:

```bash
sessions index --source cursor
sessions list --source cursor --native-id '<provider-session-id>'
```

The exact field, path, ordering, authority, and failure matrix is frozen in
[Cursor local format v1 evidence](../research/cursor-format-v1.md).
