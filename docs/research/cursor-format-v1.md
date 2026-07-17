# Cursor local format v1 evidence

- Status: implemented M11b format contract
- Date: 2026-07-16
- Evidence: sanitized structural scan of the local Cursor source

This page freezes the two local Cursor formats supported by M11b. It records
field names, types, ownership, ordering, and failure rules without private paths,
IDs, titles, content, hashes, or blob values.

The exhaustive scan covered 330 chat metadata files, 41 project catalogs, 903
catalog agent rows, 1,195 immutable selected roots, and 54,727 root-selected
messages. The implementation must stop if fixtures or later structural evidence
contradict this matrix.

## Supported families

- `chat-store-v1`
- `agent-checkpoint-store-v1`

JSONL-only history, legacy Composer/App Support state, cloud-only evidence, and
inferred relations are not supported.

## Root-relative discovery grammar

All placeholders below are one opaque regular directory component:

```text
chats/<scope>/<native-id>/meta.json
chats/<scope>/<native-id>/store.db

projects/<project>/sdk-agent-store/<scope>/index.db
projects/<project>/sdk-agent-store/<scope>/agents/agent-<sha256(agent_id)>/store.db
```

Traverse chat scopes, project directories, and SDK-agent scopes in binary
component order. Do not recurse beyond this grammar or join across scopes. Chat
scope, project, and agent scope are containment only; they are not identity,
workspace, or public metadata.

Each chat metadata file maps only to its sibling store. Each catalog maps only
to the `agents` directory beside that exact catalog. All 892 observed agent
stores had exactly one such catalog ancestor. The raw chat directory ID or
catalog `agent_id` is native identity; the agent directory suffix must equal the
lowercase SHA-256 of the exact UTF-8 `agent_id`.

A valid conversation metadata record or nonnull valid checkpoint with a missing,
nonregular, or already-claimed derived store makes discovery incomplete; it is
never silently skipped or joined to another scope. Duplicate native IDs also
make discovery incomplete. Schema, identity, or root conflicts found only after
a store is opened are candidate read failures, leaving last-good evidence stale
or first capture unindexed.

### Stable discovery generation

Discovery is complete only after two matching inventories around catalog
materialization and candidate construction. Each inventory records, in binary
order:

- relevant `chats` and `projects` directory entries, file types, and
  identity/stat descriptors;
- every traversed chat, project, SDK-agent scope, catalog, and derived store
  entry;
- main and optional WAL descriptors for each selected SQLite file; and
- each admitted chat metadata file captured read-only/no-follow where supported,
  with matching pre/post descriptors and a bytes digest.

The second inventory must match the first exactly. A relevant addition, removal,
replacement, type change, descriptor change, or metadata-bytes change is
`source-changed`; discovery is incomplete and retained Cursor sessions are not
reconciled as missing. Provider SHM is never inventoried or opened.

### Deferred-layout detection

The only deferred signature inspected by M11b is a non-symlink directory at:

```text
projects/<project>/agent-transcripts
```

Inspect it only as an immediate child while traversing each project. Do not walk
or read its JSONL files. Legacy/App Support and cloud-only state are outside the
Cursor root and are not inspected.

Precedence is fixed:

- supported candidates present: return the complete supported generation and
  ignore deferred evidence;
- no candidates, but only recognized `hasConversation: false` or null-checkpoint
  records: return a complete empty generation;
- no candidates and at least one deferred signature: `unsupported-format`, so
  discovery is incomplete;
- no supported, noncandidate, or deferred evidence: return a complete empty
  generation.

## Chat metadata

`chats/<scope>/<native-id>/meta.json` has:

| Field             | Rule                                                   | Authority             |
| ----------------- | ------------------------------------------------------ | --------------------- |
| `schemaVersion`   | required number exactly `1`                            | format version        |
| `createdAtMs`     | required nonnegative safe integer                      | session created time  |
| `updatedAtMs`     | required nonnegative safe integer, not before creation | session updated time  |
| `hasConversation` | required boolean                                       | candidate eligibility |
| `cwd`             | optional well-formed string                            | workspace             |
| `title`           | optional well-formed string                            | preferred title       |

No other keys are supported. Convert times with
`new Date(value).toISOString()`. `hasConversation: false` is a recognized
metadata-only noncandidate. The raw directory ID is native identity.

## Agent catalog

Only the consumed `agents` table is authoritative. Other tables and unconsumed
columns are ignored.

| Column                       | Required shape               | Use                               |
| ---------------------------- | ---------------------------- | --------------------------------- |
| `agent_id`                   | nonempty `TEXT PRIMARY KEY`  | native identity                   |
| `workspace_ref`              | `TEXT NOT NULL`              | validated opaque metadata         |
| `status`                     | `TEXT NOT NULL`              | validated opaque metadata         |
| `active_run_id`              | nullable `TEXT`              | validated, not canonicalized      |
| `latest_checkpoint_ref_json` | nullable `TEXT`              | candidate and root selection      |
| `name`                       | nullable `TEXT`              | title                             |
| `metadata_json`              | `TEXT NOT NULL DEFAULT '{}'` | validated JSON, not canonicalized |
| `created_at`                 | `TEXT NOT NULL`              | session created time              |
| `updated_at`                 | `TEXT NOT NULL`              | session updated time              |

Timestamps must be canonical `YYYY-MM-DDTHH:mm:ss.sssZ` values:
`Date.parse(value)` is finite and `new Date(value).toISOString() === value`.
Updated time cannot precede created time.

A null checkpoint is a recognized noncandidate. A candidate checkpoint is exact
JSON with no extra keys:

```json
{
  "blobId": "<64 lowercase hex characters>",
  "storeKind": "local-agent-store"
}
```

The store directory is `agent-<sha256(agent_id)>`. Catalog identity and
checkpoint selection are authoritative; JSONL and run-event views are ignored.

## Store database

The exact user schema is:

- `blobs(id TEXT PRIMARY KEY, data BLOB)`
- `meta(key TEXT PRIMARY KEY, value TEXT)`

Unreferenced blobs are allowed. A materialized store has exactly one metadata row
with key `"0"`. Its value is even-length lowercase hex containing UTF-8 JSON:

| Field              | Shape                             | Use                                         |
| ------------------ | --------------------------------- | ------------------------------------------- |
| `agentId`          | required string                   | cross-check native identity                 |
| `createdAt`        | required nonnegative safe integer | validation evidence only                    |
| `isRunEverything`  | required boolean                  | validated, ignored                          |
| `latestRootBlobId` | required string                   | chat root; ignored for agent root selection |
| `mode`             | required string                   | validated opaque metadata                   |
| `name`             | required string                   | chat title fallback                         |
| `lastUsedModel`    | optional string                   | validated, ignored                          |

No other keys or metadata rows are supported. Chat `agentId` must equal the raw
chat directory ID and `latestRootBlobId` must be 64-character lowercase hex.
Agent `agentId` must equal the catalog ID; its root comes from the catalog
checkpoint. Mode and model fields never select behavior.

## Selected root

The selected root is a complete version-1 wire stream. These field/wire pairs
are supported:

```text
1/2, 3/2, 4/2, 5/2, 7/2, 8/2, 9/2, 10/0, 15/2, 16/2,
18/2, 21/2, 22/2, 26/0, 27/2
```

Field `1` is a repeated length-delimited 32-byte blob ID. Preserve its wire order
and duplicates, convert each value to lowercase hex, and load that exact blob.
Other supported fields are opaque and skipped. Do not recurse or infer meaning.
An empty field-1 sequence is a valid empty session.

Unknown field/wire pairs are unsupported. Malformed wire values, missing selected
blobs, non-BLOB roots, or non-JSON selected messages are malformed.

## Messages

Messages have required `role` and `content`, plus optional `id` and
`providerOptions`. No message timestamp exists, so canonical entries omit it.
`id` may be used only in a private source locator. Provider options are validated
as objects and ignored. No other keys are supported.

| Role        | Supported content                                                         |
| ----------- | ------------------------------------------------------------------------- |
| `system`    | string                                                                    |
| `user`      | string or an array of `text` items                                        |
| `assistant` | array of `text`, `reasoning`, `redacted-reasoning`, and `tool-call` items |
| `tool`      | array of `tool-result` items                                              |

Other roles or role/content pairings are unsupported.

Content records have exact keys:

- `text`: `{ type: "text", text: string }`
- `reasoning`:
  `{ type: "reasoning", text: string, signature: string, providerOptions: object }`
- `redacted-reasoning`:
  `{ type: "redacted-reasoning", data: string, providerOptions: object }`
- `tool-call`:
  `{ type: "tool-call", toolCallId: string, toolName: string, args: object }`
- `tool-result`: required `type`, `toolCallId`, `toolName`, `result`, and
  `experimental_content`; optional `providerOptions`

Reasoning text becomes a model reasoning entry; signature and provider options
are ignored. Redacted reasoning becomes one omission with
`contentClass: "unknown"` and `sourceType: "redacted-reasoning"`; its data is
never persisted or fetched.

Tool-call arguments use the existing RFC 8785 canonical JSON writer. No namespace
was observed, so namespace remains absent.

Tool-result `result` supports:

- a well-formed string;
- an ordinary JSON object accepted by the RFC 8785 writer; or
- a finite safe JSON number.

The primary result segment is the string itself or the RFC 8785 representation.
Then process `experimental_content` in order:

- `{ type: "text", text: string }`: omit only when it exactly duplicates a
  string primary result; otherwise preserve it as another text segment;
- `{ type: "image", mimeType: string, data: string }`: emit one ordered omission
  with `contentClass: "image"` and `sourceType: "image"`; validate the MIME type
  but never persist or fetch MIME or image data.

Other result types or experimental records are unsupported. A tool result must
link to exactly one earlier call with the same nonempty ID and tool name. Store
the relation ordinal and call ID; omit the redundant result name. Missing,
duplicate, or inconsistent linkage is malformed.

## Canonical ordering and lineage

Preserve root-message order and content-array order:

- scalar system/user text becomes one message entry;
- every text item becomes one message entry;
- every reasoning item becomes one reasoning entry;
- every tool call/result becomes its own entry;
- every known redacted or image item becomes an ordered omission.

Entry and segment ordinals remain contiguous. Side chats and subagents are
independent sessions only when a supported family admits them. Relations remain
empty and `lineageCoverage` remains `unknown`.

## Failure rules

- Optional absence is omitted.
- Recognized noncandidate state is skipped.
- Structurally valid state outside this frozen matrix is `unsupported-format`.
- Missing, invalid, inconsistent, or unreadable required v1 evidence is
  `malformed`.
- Mutation around capture is `source-changed`.
- Unknown keys, roles, discriminators, schema changes, and root field/wire pairs
  are never inferred.
