# Ship the Codex-first indexed workflow

- Status: reviewed; ready for implementation
- Milestone: M5
- Date: 2026-07-14
- Plan review: passed with zero findings on 2026-07-14

## Goal

Deliver the first real Sessions user journey: discover one local Codex instance,
index its state database and rollouts without mutating them, then list and show
the resulting canonical evidence entirely from the Sessions-owned index. The
slice must prove the provider-neutral model against namespaced tools, linked
calls/results, ordered non-text omissions, lineage, evolving rollout records,
and live source changes before M6 stabilizes query semantics.

Acceptance requires the M5 exit gate in the
[program roadmap](260713-v1-implementation-roadmap.md), the authority and path
rules in the [Codex source survey](../../docs/research/codex-source-survey.md),
and the privacy/source boundaries in the
[architecture memo](../../docs/architecture-memo.md). Implementation stops at
working `index`, `index clear`, `list`, and `show`; search, recurrence analysis,
export, final machine DTOs, Cursor, and packaged Agent Skills remain later
milestones.

## Locked decisions

### Canonical evidence and schema 4

- `ContentSegment` becomes a discriminated union. `TextContentSegment` has
  `kind: "text"`, exact text, and its existing `sha256-utf8-v1` hash.
  `OmittedContentSegment` has `kind: "omitted"`, `contentClass` limited to
  `image | resource | structured | unknown`, and one non-empty, well-formed,
  sanitized `sourceType`. Both variants retain ordinal, origin, confidence, and
  string-only source metadata.
- Omitted segments never contain text, hashes, bytes, serialized opaque objects,
  data/remote URLs, or local paths. Only text enters content interning, FTS, and
  later recurrence measures.
- `SessionEntry` adds optional exact `toolName` and `toolNamespace`. Both are
  valid only on `tool-call`; namespace requires a name. Preserve M1's existing
  generic admission/storage semantics for `toolCallId` and
  `relatedEntryOrdinal`: schema-3 documents may carry a call ID on another entry
  kind or a generic relation involving tool-shaped kinds, and schema 4 must
  continue to round-trip them. The Codex adapter is stricter: it writes call IDs
  only on `tool-call`/`tool-result`, links a result only to the exact matching
  call, requires matching IDs when both linked entries expose one, and leaves
  unprovable counterparts unlinked. Results never inherit name or namespace.
- Migration 4, `canonical_evidence`, adds checked tool columns and replaces the
  text-only occurrence table with one strict discriminated occurrence table.
  Its primary key continues to enforce one segment variant per
  session/entry/ordinal. A database check requires either a text `content_id` or
  omitted `content_class`/`source_type`, never both. Existing schema-3 rows copy
  as text; existing tool IDs and generic relations copy unchanged; migrations
  1–3 remain byte-for-byte unchanged. The new reader therefore has no
  reindex/rebuild requirement solely because schema 4 was applied.

### Codex source authority and identity

- V1 supports one global/default Codex instance per invocation. Its opaque
  instance ID is `local-sha256-v1:<64 lowercase hex>`, computed from a
  versioned canonical tuple of the resolved Codex home and SQLite home. The
  digest prevents private paths entering canonical IDs while keeping different
  roots isolated.
- Non-empty `CODEX_HOME` resolves relative to the captured working directory,
  does not expand a literal `~`, and must name a directory when present. The
  default is `<home>/.codex`. Existing roots use `realpath`; absent roots retain
  a normalized absolute path so an unavailable probe is still stable.
- Only top-level `$CODEX_HOME/config.toml` is read. Its top-level `sqlite_home`
  wins over non-blank `CODEX_SQLITE_HOME`, which wins over the Codex home.
  Config-relative paths resolve against `$CODEX_HOME` with the pinned upstream
  absolute-path semantics; environment-relative paths resolve against the
  captured working directory. Root `state_5.sqlite` wins. The nested
  `sqlite/state_5.sqlite` fallback is allowed only when neither config nor
  environment selected a SQLite home and the root database is absent. Roots are
  never merged, and an explicit missing or corrupt store never falls back.
- `state_5.sqlite` is required discovery/metadata authority. The row-referenced
  rollout is content authority. Missing or corrupt state never triggers a
  filesystem scan. `threads.id` and `threads.rollout_path` are required;
  metadata columns are feature-detected. A missing `thread_spawn_edges` table is
  a fingerprinted capability sentinel, while a present table with malformed
  required columns is unsupported.
- State opens through a `mode=ro`, `readOnly`, `query_only` connection and short
  deferred read transactions; it is never opened with `immutable=1` because live
  WAL content is authoritative. Refuse the unsafe WAL-present/SHM-absent shape
  before opening, and prove closed-state and active-WAL fixtures create or alter
  no provider database, sidecar, config, or rollout file.

#### State schema and canonical tuple

`threads` is supported with this exact capability map. Extra columns are ignored
and must not change a candidate fingerprint.

| Column          | Capability | Admitted value                                      | Canonical use                               |
| --------------- | ---------- | --------------------------------------------------- | ------------------------------------------- |
| `id`            | required   | non-empty, well-formed SQLite `TEXT`                | opaque native ID                            |
| `rollout_path`  | required   | non-empty, well-formed SQLite `TEXT`                | rollout selection only; never public output |
| `title`         | optional   | `TEXT` or `NULL`; empty string becomes absent       | exact session title                         |
| `cwd`           | optional   | `TEXT` or `NULL`; empty string becomes absent       | exact session workspace                     |
| `created_at_ms` | optional   | integral `INTEGER` or `NULL`, within ISO date range | preferred created time                      |
| `created_at`    | optional   | integral epoch seconds or `NULL`, within date range | fallback only when `_ms` is absent/null     |
| `updated_at_ms` | optional   | integral `INTEGER` or `NULL`, within ISO date range | preferred updated time                      |
| `updated_at`    | optional   | integral epoch seconds or `NULL`, within date range | fallback only when `_ms` is absent/null     |

Optional means the column itself may be absent. A present non-null value of the
wrong runtime type, a non-integral/out-of-range timestamp, or an invalid required
value makes discovery incomplete rather than silently dropping evidence.
Integers may arrive as `number` or `bigint`; convert without precision loss and
emit UTC ISO with milliseconds. A valid `_ms` value shadows its seconds column,
so changing only the shadowed value does not invalidate the candidate. Do not
consume or fingerprint preview/first-message, source/thread-source, model,
provider, token, archive, Git, sandbox, approval, memory/history, agent-role, or
agent-nickname columns in M5: none has a canonical session field and rollout
records remain content/provenance authority.

The `thread-row` fingerprint serializes this exact tuple order, including
capability/value tags rather than JavaScript object property order:

```text
[
  "codex-thread-row-v1",
  ["id", "text", <id>],
  ["rollout_path", "text", <rollout_path>],
  ["title", <column-absent|null|text>, <value-if-text>],
  ["cwd", <column-absent|null|text>, <value-if-text>],
  ["created", <absent|created_at_ms|created_at>, <raw-decimal-or-null>, <iso-or-null>],
  ["updated", <absent|updated_at_ms|updated_at>, <raw-decimal-or-null>, <iso-or-null>]
]
```

`thread_spawn_edges` is optional as a table. When present,
`parent_thread_id`/`child_thread_id` are required non-empty `TEXT`; `status` is an
optional `TEXT`/`NULL` capability retained only in the edge fingerprint. Query
exactly the candidate child. Zero rows is valid, one row produces the parent
relation, and multiple rows or invalid values are malformed. The
`parent-edge` tuple is exactly one of:

```text
["codex-parent-edge-v1", "table-absent"]
["codex-parent-edge-v1", "row-absent", <status-column-capability>]
["codex-parent-edge-v1", "row", <parent-id>, <child-id>, <status-column-capability>, <status>]
```

`status` does not change the V1 relation kind; including it makes the declared
input the exact observed edge row. A row produces one high-confidence `parent`
target in the same source instance. Explicit rollout metadata may confirm it or
supply a parent/fork only when no edge row exists; disagreement with a state edge
is malformed.

### Candidate and read boundary

Every candidate declares these inputs in this exact order:

1. `thread-row`: a versioned canonical tuple of every consumed required and
   optional field, with explicit absence sentinels;
2. `parent-edge`: the exact parent row or explicit row/table absence sentinel;
3. `rollout`: a representation-neutral logical locator plus a descriptor of
   presence, selected plain/Zstandard representation, containment-root class,
   and bigint-safe `dev`, `ino`, `mode`, `size`, `mtimeNs`, `ctimeNs`, and
   `birthtimeNs` values.

Each component uses `sha256-json-v1:<digest>` and the existing aggregate helper
covers all three. The whole SQLite file is never fingerprinted. A missing or
invalid referenced rollout still yields its thread candidate with an explicit
descriptor, so refresh records that session as failed/stale instead of silently
reconciling it away.

Before parsing, `read()` re-queries row/edge in one snapshot and reselects/stats
the rollout. It opens the verified file handle, stats that handle, streams it,
then stats/closes the handle, reselects the path/representation, and re-queries
row/edge. Any input or representation difference takes precedence as
`source-changed`; no partial document escapes. A stable permission failure is
`unreadable`; invalid UTF-8/JSON/Zstandard or malformed recognized records are
`malformed`; a stable record beyond the supported bound or known incompatible
schema is `unsupported-format`.

Plain and `.zst` names represent one logical rollout and plain wins when both
exist. A rollout is eligible only when its exact `rollout-*.jsonl[.zst]`
basename ends in the row's native thread ID, it is a regular file, and its
canonical path remains below canonical `sessions` or `archived_sessions`.
Relative database values resolve from the Codex home. Traversal, symlink escape,
special files, and unrestricted absolute paths are never opened.

### Streaming and dependencies

- Stream `FileHandle.createReadStream()` through optional
  `createZstdDecompress()`, a custom byte-bounded JSONL splitter, and the
  stateful normalizer with `pipeline()` from `node:stream/promises`. Use fatal
  UTF-8 decoding and parse one record at a time. Blank, ignored, and unknown
  records break duplicate adjacency. A valid final JSON record needs no trailing
  newline; a stable incomplete record is malformed.
- Cap each decompressed JSONL record at 32 MiB before concatenation or decoding.
  The sanitized survey found 1,070,437 records with a 16,301,774-byte maximum;
  fixtures prove the exact cap and cap-plus-one behavior. The current source port
  still materializes the normalized `SessionDocument`; M5 promises bounded raw
  record memory, not constant-memory whole-session persistence.
- Add only `smol-toml@1.7.0` as a pinned production dependency after lockfile,
  license, packed-size, and existing-dependency checks. Limit config input to
  1 MiB, retain no parsed config beyond path resolution, and sanitize all parser
  failures.
- Do not add Zod in M5. The rollout loop is a million-record, forward-compatible
  boundary; small cached hand-written discriminant/field admissions avoid object
  cloning, preserve intentional unknown-field tolerance, and reuse current
  sanitized validation patterns. Reconsider Zod or Zod Mini for M7 only if one
  stable public DTO schema would replace duplicated types and a benchmark shows
  acceptable package/runtime cost.

### Codex rollout normalization matrix

The checked-in M5 support document and parser implement this matrix, pinned to
the upstream revision cited by the source survey. Every JSONL record must be a
plain object with a non-empty string `type`; recognized outer records require a
plain-object `payload`. Extra object keys are tolerated and never copied
wholesale. A present top-level timestamp must be a valid RFC3339 string and is
normalized to canonical UTC milliseconds. Required IDs/names are non-empty,
well-formed strings. A required field with the wrong shape makes that candidate
`malformed`; an unknown discriminator uses the explicit treatment below.

Every emitted entry receives the next canonical ordinal and a private logical
rollout locator plus decimal source-record ordinal. Text source metadata contains
only bounded format tags. Nested structured arguments explicitly marked
`canonical JSON` use recursive binary-key ordering, array-order preservation, and
no whitespace; arbitrary unrecognized objects are never serialized.

#### Outer records

| Outer `type`                         | Required/admitted fields                                          | V1 projection                                                                                                      |
| ------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `session_meta`                       | current `id`/`session_id`; optional parent/fork, base/tool fields | metadata/lineage plus injected entries described below; repeated records never create another session              |
| `turn_context`                       | object; optional `turn_id`; legacy instruction strings            | turn/link metadata; legacy instructions become injected entries; policy/path/model fields are skipped              |
| `response_item`                      | payload string `type`                                             | authoritative message/tool/reasoning/compaction dispatch                                                           |
| `event_msg`                          | payload string `type`                                             | lifecycle/diagnostic dispatch and fallback message/tool evidence                                                   |
| `inter_agent_communication`          | string content; author/recipient values                           | `inter-agent-message`, actor `model`, origin `delegated`; encrypted part becomes an omitted segment                |
| `inter_agent_communication_metadata` | optional boolean `trigger_turn`                                   | metadata only; never standalone text                                                                               |
| `compacted`                          | string `message`; optional replacement/window fields              | `compaction` marker followed by visible message text; replacement history is skipped; window IDs are metadata only |
| `world_state`                        | any valid payload object                                          | known skip; never retain state/snapshot content                                                                    |
| unknown valid outer type             | no additional admission                                           | one `unknown` entry with an omitted `unknown`/safe-discriminator segment; no payload copy; clear message adjacency |

For `session_meta`, at least one effective record must identify the discovered
native thread. A record identifying another inherited thread marks replay
context and cannot replace current metadata or create another session.
`parent_thread_id` and `forked_from_id` are optional non-empty IDs. On a current
record they may confirm the state parent, or supply respectively one
`parent`/`fork` relation only when the state edge is absent; conflicting current
values are malformed. `base_instructions.text` becomes one `injected-context` entry,
actor `system`, origin `injected`. `dynamic_tools`/`additional_tools` are catalog
evidence, never invocations: for each ordered recognized item preserve exact
name and description as injected text and represent its schema as omitted
`structured`/`tool-schema`; malformed/unknown catalog items become ordered
omitted `structured` segments. Paths, Git, capability roots, model/provider,
history/memory, agent labels, and config policy remain non-content metadata or
are skipped.

For `turn_context`, current fields other than `turn_id` are metadata-only.
Legacy optional string `user_instructions` and `developer_instructions`, when
present in older rollouts, become separate `injected-context` entries in that
fixed order, actor `system`, origin `injected`. They are retained on every source
occurrence; they never become human intent.

#### Authoritative `response_item` payloads

| Payload `type`            | Required/admitted fields                                     | Canonical projection                                                                                                  |
| ------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `message`                 | string `role`, array `content`, optional `phase`             | `message`; user -> human/human, assistant -> model/model, developer -> system/injected, system -> system/system       |
| `agent_message`           | author, recipient, array `content`                           | `inter-agent-message`, actor model, delegated segments; encrypted nested content omitted                              |
| `reasoning`               | array `summary`; optional `content`/`encrypted_content`      | `reasoning-summary`; visible `summary_text` only; each hidden/raw/encrypted field becomes one omitted unknown segment |
| `function_call`           | `call_id`, `name`, string `arguments`; optional `namespace`  | `tool-call`, actor model, exact ID/name/namespace, one exact argument text segment                                    |
| `function_call_output`    | `call_id`, string or recognized-item-array `output`          | linked `tool-result`, actor tool; ordered output segments; no copied name/namespace                                   |
| `custom_tool_call`        | `call_id`, `name`, string `input`; optional `namespace`      | same call projection with exact input text                                                                            |
| `custom_tool_call_output` | `call_id`, string or recognized-item-array `output`          | same result projection; optional output `name` never supplies result identity                                         |
| `local_shell_call`        | optional `call_id`/legacy `id`, status, recognized `action`  | `tool-call`, source-observed name `local_shell`; known command/action strings in source order; no cwd/path retention  |
| `tool_search_call`        | optional `call_id`, string `execution`, JSON `arguments`     | `tool-call`, name `tool_search`; execution text then canonical JSON arguments                                         |
| `tool_search_output`      | optional `call_id`, string status/execution, array `tools`   | `tool-result`; execution text plus ordered recognized tool name/description or omitted structured catalog items       |
| `web_search_call`         | optional `id`, status, recognized optional `action`          | `tool-call`, name `web_search`, ID as call ID when present; exact query text for recognized search/open/find actions  |
| `image_generation_call`   | optional `id`, string status/result, optional revised prompt | call named `image_generation` plus linked result; prompt is text, generated result is omitted `image`                 |
| `additional_tools`        | string role, array `tools`                                   | `injected-tool-catalog` using the catalog rules above; never `tool-call`                                              |
| `compaction`              | string `encrypted_content` (`compaction_summary` alias)      | `compaction` marker with one omitted `unknown`/`encrypted-compaction` segment                                         |
| `context_compaction`      | optional string `encrypted_content`                          | `compaction` marker and optional encrypted omission                                                                   |
| `compaction_trigger`      | object                                                       | known request-control skip                                                                                            |
| `other`/unknown type      | no additional admission                                      | one `unknown` entry with one privacy-safe omitted segment; clear adjacency                                            |

`message.content` supports `input_text` and `output_text` as exact ordered text
and `input_image` as ordered omitted `image`/`input-image`. Unknown content items
become ordered omitted `unknown`/`unknown-content-item`; URLs are not retained.
Agent-message `input_text` is exact delegated text and `encrypted_content` is an
omitted `unknown`/`encrypted-agent-content` segment. Reasoning summary items
require string `summary_text`; raw reasoning content is never made searchable.

Function/custom result arrays support `input_text`/`output_text` as exact text,
`input_image` as omitted image, encrypted content as omitted unknown, and known
MCP resource/link/image/audio values as omitted `resource` or `image` with a safe
source type. Unknown array items are omitted `structured`; array order is
canonical segment order. Empty call arguments/results remain exact empty text
when the source field exists.

#### `event_msg` payloads

| Payload `type`                                                                  | Required/admitted fields                                        | Canonical projection                                                                                                                   |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `user_message`                                                                  | string `message`; optional image/local-image arrays             | fallback `message` human/human; text first, then omitted images in source array order; never retain references                         |
| `agent_message`                                                                 | string `message`                                                | fallback `message` model/model                                                                                                         |
| `agent_reasoning`                                                               | string `text`                                                   | fallback `reasoning-summary`; raw-content and delta variants are known skips                                                           |
| `task_started` (`turn_started` alias)                                           | non-empty `turn_id`                                             | `turn-started` marker and exact-ID lookup key                                                                                          |
| `task_complete` (`turn_complete` alias)                                         | non-empty `turn_id`; optional error/times                       | `turn-completed` marker related to matching start; optional error becomes a following diagnostic; ignore last-agent-message            |
| `turn_aborted`                                                                  | reason/turn ID fields admitted when present                     | `turn-aborted` marker related only by exact turn ID; no success/failure inference                                                      |
| `thread_rolled_back`                                                            | non-negative integral `num_turns`                               | `rollback` marker; count is validated but not retained because no canonical status field exists                                        |
| `context_compacted`                                                             | empty object                                                    | fallback `compaction` marker                                                                                                           |
| `error`, `warning`, `guardian_warning`, `stream_error`, `deprecation_notice`    | documented string message/summary/details fields                | `diagnostic` entry with exact user-visible text; operational objects/codes are not copied                                              |
| `mcp_tool_call_begin` / `mcp_tool_call_end`                                     | `call_id`; invocation server/tool/arguments; end result         | fallback call/result; name=tool, namespace=server, canonical JSON args, recognized ordered result text/omissions                       |
| `dynamic_tool_call_request` / `dynamic_tool_call_response`                      | `call_id`, optional namespace, `tool`, JSON arguments/content   | fallback call/result with exact ID/name/namespace; recognized ordered text/image outputs                                               |
| `exec_command_begin` / `exec_command_end`                                       | `call_id`, command array; terminal output fields                | fallback call/result named `exec_command`; command as canonical JSON; no cwd; result prefers formatted, aggregate, stdout/stderr order |
| `patch_apply_begin` / `patch_apply_end`                                         | `call_id`; end stdout/stderr                                    | fallback call/result named `apply_patch`; path/change maps omitted structured; result text ordered stdout then stderr                  |
| `web_search_begin` / `web_search_end`                                           | `call_id`; end query/action/results                             | fallback call/result named `web_search`; query text; result objects omitted structured                                                 |
| `image_generation_begin` / `image_generation_end`                               | `call_id`; end status/result/revised prompt                     | fallback call/result named `image_generation`; prompt text; result omitted image                                                       |
| `view_image_tool_call`                                                          | `call_id`, path field                                           | fallback call named `view_image` with one omitted `image`/`local-image`; path never retained                                           |
| `sub_agent_activity`, review-mode, and collab begin/end/wait/close/resume types | their documented IDs/kinds, optional user-visible review output | provider-neutral lifecycle/agent-activity markers; visible review output text only; never synthesize session relations                 |
| `item_completed` containing a `plan` item                                       | item/plan text                                                  | `plan` entry with exact plan text                                                                                                      |

Known event skips are: token/session/settings/goal/MCP-startup updates; realtime,
routing, verification, moderation, buffering, approval, permission, elicitation,
guardian, hook, shutdown, and raw-response wrappers; item-start and non-plan
item-completed wrappers; command/patch/message/plan/reasoning deltas; terminal
interaction; plan-update and turn-diff UI mirrors. A valid event type not listed
above becomes the same privacy-safe `unknown` omitted marker as any other unknown
payload. Every known skip clears adjacent-message eligibility.

#### Precedence, linkage, and duplicate rules

1. Direct `response_item` call/result evidence wins over event fallback with the
   same call ID. Event fallback may supply the missing opposite side but never a
   duplicate call/result. Conflicting call name/namespace for one ID is
   malformed.
2. Calls/results reconcile across the complete rollout by exact call ID,
   including result-before-call. A result relation is added only when exactly one
   matching call exists. Duplicate conflicting calls/results are malformed;
   unmatched evidence remains canonical and unlinked.
3. Collapse messages only when physically adjacent, cross-family
   response/event representations have the same actor and identical complete
   ordered segment variants/values/origins. Keep the richer response item.
   Preserve same-family, non-adjacent, or partially different repeats.
4. `compacted` beats response compaction, which beats `context_compacted`, only
   when the representations are adjacent and structurally identify the same
   event. Replacement history is replay context, never fresh canonical entries.
5. Tool catalogs, user requests, model claims, and plain-text names never become
   calls. Task completion never means success. State spawn edges own lineage;
   equal text never creates replay, delegation, fork, or parent evidence.

### M5 command surface

- `sessions index [--source codex] [--format human|json]` selects all registered
  sources when omitted. Unknown/unregistered sources are usage failures before a
  writer opens. A complete report exits `0`; a fully rendered incomplete report
  exits `1`.
- `sessions index clear [--format human|json]` calls only the existing
  Sessions-owned maintenance port. Both absent and cleared outcomes exit `0`.
- `sessions list [--limit N]` is human-only until M7. Default `N` is 50 and the
  maximum is 200. Order is `coalesce(updatedAt, createdAt)` descending with
  missing timestamps last, then canonical printable ID by binary UTF-8 order.
  The service requests `N + 1`, returns explicit truncation, and pushes the SQL
  bound into the repository.
- `sessions show <canonical-id> [--entry N --context N]` is human-only until M7.
  Without `--entry`, show the first 50 entries and report the displayed range and
  total. With an entry, default context is 3 on each side; maximum context is 100. `--context` without `--entry` is invalid usage. Missing IDs/entry ordinals
  are operational failures. Each text segment is capped at 8 KiB of UTF-8 output
  and the entry body at 256 KiB, with explicit truncation; omitted segments render
  only class and sanitized source type.
- List/show receive only index lifecycle/paths and never a source adapter. They
  omit `sourceLocator` and `sourceMetadata`, escape terminal controls in every
  untrusted scalar, and remain unchanged when provider files change or vanish.
  Final JSON/JSONL DTOs, `--full`, pagination, query filters, and corpus-tuned
  bounds remain M6–M7 work.

## Changes

1. `src/domain/session.ts:ContentSegment` and `SessionEntry`,
   `src/domain/session-validation.ts:validateSessionDocument`, and
   `src/application/validate-session.ts` — implement the canonical evidence
   union and tool/link invariants above. Preserve contiguous mixed segment
   ordinals and deep immutable snapshots. Update `test/fixtures/session.ts`, the
   synthetic source, and source/index contract helpers to construct explicit
   text or omitted variants. Keep a legacy non-tool `toolCallId` fixture and add
   separate canonical `tool-call`/`tool-result` evidence fixtures.

2. `src/infrastructure/sqlite/migrations/0004-canonical-evidence.ts` and
   `src/infrastructure/sqlite/migrations.ts` — add schema 4 without editing prior
   migrations. Rebuild occurrences transactionally, recreate its content index
   as a partial index for non-null `content_id`, and retain all tracking, run,
   lease, FTS, and last-good state. Add a schema-3-to-4 migration test proving
   exact text/FTS preservation, SQL impossible-state checks, clean foreign keys,
   rollback, and unchanged writer history. Seed currently valid schema-3 rows
   containing a non-tool call ID and a tool-result relation to a non-call entry;
   prove both survive migration and reconstruction unchanged.

3. `src/infrastructure/sqlite/sqlite-session-document.ts` and focused repository
   tests/contracts — persist tool identity; intern only text; write omitted rows
   with no content ID; `LEFT JOIN` and discriminate on reconstruction; reject
   corrupt XOR/tool columns before domain admission. Prove text–omitted–text
   round trip, no omitted FTS/hash/content-value row, collision/dedup behavior,
   atomic replacement/removal, garbage collection, and linked result identity.

4. `src/adapters/codex/config.ts`, `paths.ts`, and `source-instance.ts` — implement
   the captured-environment path algorithm, bounded TOML read, root/legacy
   precedence, opaque instance digest, rollout logical-name selection, and
   realpath containment. Unit fixtures cover missing/empty/relative/literal-tilde
   environment values, config tables/comments/relative/`~/`/wrong-type values,
   config-over-environment precedence, explicit missing/corrupt roots, root over
   legacy, filename/ID mismatch, archive/session roots, traversal, symlink
   escape, special files, and plain-over-Zstandard selection.

5. `src/adapters/codex/state-db.ts` and `fingerprint.ts` — build a read-only,
   query-only state gateway with stable schema/row/edge snapshots, dynamic SQL
   limited to feature-detected identifiers, binary thread ordering, strict
   runtime type admission, canonical absent values, and bigint-safe hashing.
   Implement the exact column map, timestamp precedence, and tuple order above;
   no other state field may enter normalization or fingerprints. Tests mutate
   every consumed field independently, prove shadowed/unconsumed changes do not
   invalidate candidates, distinguish missing edge table/row/status capability,
   reject ambiguous multiple parents and malformed schemas, and snapshot
   provider files before and after both closed and live-WAL reads.

6. `src/adapters/codex/rollout.ts` — implement the backpressured plain/Zstandard
   record pipeline and 32 MiB splitter. Follow the Node streaming guidance:
   propagate source/transform/sink failures through awaited `pipeline()`, close
   the file handle on every path, and preserve the primary plus close error when
   both fail. Focused tests cover chunk/newline boundaries, CRLF/blank lines,
   invalid UTF-8/JSON/Zstandard, valid no-newline EOF, stable truncated EOF,
   cap/cap-plus-one, early consumer failure, and handle cleanup.

7. `src/adapters/codex/format-support.ts`, `normalize.ts`, and `lineage.ts` plus
   `docs/reference/codex-format-support.md` — encode and document one tested
   record matrix pinned to the surveyed upstream format:

   - metadata-only: session metadata and turn context fields consumed for
     explicit provenance/replay boundaries;
   - canonical messages: response/event user, assistant, developer, system, and
     explicit inter-agent text; ordered input/output text plus image/resource/
     opaque omissions; explicit provider instruction fields/roles retained as
     injected content, not stripped;
   - canonical tools: function, custom, local-shell, dynamic/MCP, tool-search,
     and web-search calls/results when structural evidence exists; exact call
     IDs, separate names/namespaces, exact argument text, ordered recognized
     result text/omissions, non-adjacent and result-before-call backfill, and
     unmatched evidence without invented status;
   - canonical markers: task/turn start, complete, abort, compaction, and
     rollback, with exact-ID relations where available and no success inference;
   - visible evidence: explicit reasoning summaries only;
   - known omission: encrypted/hidden reasoning, world state, ghost snapshots,
     replacement history, provider caches, raw tool schemas, and unsupported
     opaque payload content;
   - forward compatibility: unknown outer/payload variants become `unknown`
     entries containing one non-searchable omitted segment; its class is
     `unknown` and its source type is a bounded safe provider discriminator or
     `unknown-record`, never raw payload data. These records clear adjacency;
     malformed shapes of recognized variants fail the session.

   Collapse only an adjacent, cross-family event/response message pair whose
   actor and complete ordered content—including omitted classes—match exactly;
   retain the richer response-item projection. Preserve same-family and
   non-adjacent repeats. A state spawn edge produces one high-confidence parent
   relation; no reciprocal child, inferred fork, inferred replay, or text-based
   lineage. Golden fixtures cover every matrix row and ambiguity.

8. `src/adapters/codex/source.ts` — compose probe/discover/read over those modules
   and expose `createCodexSource()` through the existing internal
   `SessionSource` port. Discovery reads state rows and file metadata only, emits
   deterministic candidates including missing/invalid rollouts, and never reads
   transcript content. Read owns all pre/post verification and maps failures to
   the shared sanitized error union. Run the shared source conformance suite with
   fixture-owned mutation hooks for row, edge, representation, path, bytes, and
   during-read changes; increment one explicit adapter format version whenever
   normalization semantics change.

9. `src/application/ports/session-index.ts:SessionIndexReader`,
   `src/infrastructure/sqlite/sqlite-session-state.ts`,
   `src/infrastructure/sqlite/sqlite-session-index.ts`, and
   `src/infrastructure/sqlite/database.ts` — add
   `listSummaries({ limit })` to the provider-neutral reader and implement the
   locked bound/order inside SQLite. Add `src/application/list-sessions.ts`,
   `show-session.ts`, and a shared reader-lifecycle helper only if needed to keep
   open/operation/close aggregation consistent. Application tests prove bounds,
   truncation, missing state/identity/entry behavior, close on all paths, and the
   absence of any source-adapter dependency.

10. Extract `src/application/admit-source-probe.ts` from the private validator in
    `run-index.ts`; reuse it from indexing, `get-paths.ts`, and a new generic
    source diagnostic. Extend paths schema version 1 additively with sorted
    source status and only the Codex home/effective state roots. Add
    `source-codex` after the existing doctor checks; unavailable, unreadable,
    malformed, and thrown probes become sanitized failed checks. Probe tests
    prove no rollout read, no state creation/migration, stable ordering, and no
    raw parser/path error leakage.

11. Split `src/cli/program.ts` into focused command registration and human/JSON
    renderers while retaining `createProgram()` as orchestration. Add index,
    clear, list, and show handlers to `src/cli/run.ts`; generalize
    `OperationalExit`; validate all numeric/source/identity arguments before
    opening state. Add a central terminal-safe, UTF-8-bounded scalar renderer.
    CLI tests lock generated help, nested clear routing, the command semantics and
    exit codes above, stdout/stderr separation, report completeness, bounds, and
    ANSI/control/prompt-like transcript handling.

12. `src/bin/sessions.ts` — remain the only composition root and the only place
    that imports Codex. Register a lazy `codex` source factory: help, version,
    list, show, and clear must not resolve config or touch provider paths; index,
    paths, and doctor load/probe intentionally. Compose existing SQLite writer,
    reader, and maintenance implementations without adding provider branches to
    them.

13. `test/fixtures/codex/`, `test/adapters/codex/`, and an end-to-end CLI test —
    generate minimal base/current/optional-column SQLite databases and synthetic
    JSONL/Zstandard rollouts; never copy local material. Prove index -> list ->
    show; delete/poison provider state and prove list/show identical; attempt a
    failed refresh and prove last-good output remains; clear and prove only
    Sessions-owned files disappear. Before/after recursive metadata snapshots
    must find no provider mutation or new sidecars.

14. `scripts/smoke-dist.ts` and `scripts/smoke-package.ts` — reuse the synthetic
    fixture builder to exercise doctor, paths, index, list, show, provider
    removal with index-only reads, and clear through compiled and offline packed
    installs. Keep smoke output content synthetic and assert the packed CLI never
    depends on the source checkout.

15. `package.json`, `pnpm-lock.yaml`, `README.md`, `docs/privacy.md`,
    `docs/reference/cli-contract.md`, `docs/contributing/adapter-contract.md`,
    `docs/contributing/architecture.md`, `docs/contributing/testing.md`, and the
    contributor index — add the reviewed TOML dependency and make current versus
    planned behavior honest. Document installation-to-first-index usage, Codex
    path precedence/support limits, human-only M5 list/show output, exact bounds,
    source read-only guarantees, omitted-content privacy, Zod deferral, and the
    remaining M6–M8 work. Update the roadmap/current-state labels only after the
    implementation checks pass.

## Verify

- Focused domain/storage gates:
  `pnpm vitest run test/domain/session-validation.test.ts test/application/validate-session.test.ts test/infrastructure/sqlite-canonical-evidence-migration.test.ts test/infrastructure/sqlite-session-index.test.ts`.
- Focused adapter gates: `pnpm vitest run test/adapters/codex` plus the shared
  source contract invocation.
- Focused application/CLI gates:
  `pnpm vitest run test/application/list-sessions.test.ts test/application/show-session.test.ts test/application/run-index.sqlite.test.ts test/cli.test.ts`.
- Distribution proofs: `pnpm build && pnpm smoke:dist && pnpm smoke:package`.
- Inspect `git diff -- package.json pnpm-lock.yaml` and packed contents/size to
  confirm exactly `smol-toml@1.7.0` was added at runtime and Zod was not.
- Run `pnpm check` on every supported CI operating system.
- Run the repository change-review workflow after implementation; resolve all
  accepted findings and rerun affected focused gates plus `pnpm check`.

## Boundaries

- Do not read personal transcripts in tests, commit surveyed values, or put
  machine paths/IDs/content into fixtures, snapshots, reports, or docs.
- Do not port Harness caching, classifications, automation filters, workflow
  analysis, whole-file parsing, preamble stripping, or query-time source reads.
- Do not add filesystem discovery fallback, multi-profile Codex resolution,
  whole-rollout hashing during discovery, attachment fetching/OCR, hidden
  reasoning recovery, or causal/skill-use inference.
- Do not change query/storage policy for Codex. If a source format cannot enter
  the generic model, stop and review the model before adding an adapter special
  case.
- Stop if provider opening creates a sidecar or changes provider metadata, if an
  input consumed by normalization is absent from the candidate fingerprint, if
  containment/identity cannot be proven, or if parsing requires an unbounded raw
  record/whole-file buffer.
- Do not pull M6 search/filter/recurrence, M7 export/final DTOs/`--full`, M8
  Cursor, or packaged skill analysis into this change.
