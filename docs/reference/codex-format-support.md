# Codex format support

- Status: current M6 contract
- Adapter format version: `codex-v3`
- Survey baseline: upstream Codex commit
  [`d7ba5ff9553a6aa0898a8e3bd5cb3bc00d0c9ddf`](https://github.com/openai/codex/tree/d7ba5ff9553a6aa0898a8e3bd5cb3bc00d0c9ddf)

This page defines the Codex rollout records that Sessions interprets. It is a
closed support matrix, not a claim that every Codex record has the same shape
forever. Unknown structural records remain observable as non-searchable
omissions. A recognized record with a malformed supported field fails that
session capture rather than silently changing its meaning.

`codex-v2` added explicit complete/unknown lineage-coverage evidence. `codex-v3`
accepts Codex's distinct thread and group identities while projecting only the
thread identity. A retained V2 candidate is re-read once under V3 rather than
silently reinterpreted; after successful V3 capture, an unchanged candidate
again skips the rollout read.

Sessions reads Codex files without changing them. It stores canonical evidence,
not raw JSON records, encrypted values, image URLs, local image paths, world
state, or provider caches.

## Instance and path resolution

Sessions resolves one global/default Codex instance:

1. Non-blank `CODEX_HOME`, relative to the current directory when relative;
   otherwise `~/.codex`.
2. A string `sqlite_home` in `<codex-home>/config.toml`, relative to the Codex
   home (with `~` expansion); otherwise non-blank `CODEX_SQLITE_HOME`, relative
   to the current directory; otherwise the Codex home.
3. `state_5.sqlite` under the selected SQLite home. Only for the default
   selection, a missing root state file can fall back to
   `<codex-home>/sqlite/state_5.sqlite`.

The TOML file is read-only, limited to 1 MiB, and parsed as UTF-8. Invalid or
unreadable configuration fails source construction with a sanitized error. The
canonical Codex/SQLite roots form the stable local source-instance identity;
diagnostics do not publish the raw roots as the identity.

Rollout paths come only from admitted state rows. Plain
`rollout-*.jsonl` wins over its `.zst` representation when both exist. The
resolved regular file or provably missing parent must remain beneath the
canonical `sessions` or `archived_sessions` root; symlink escapes and unexpected
names are malformed. Sessions does not discover profiles, projects, cloud
histories, or arbitrary rollout trees.

## State database support

The required `threads` table must expose non-empty text `id` and `rollout_path`.
The adapter feature-detects optional `title`, `cwd`, `created_at_ms`,
`created_at`, `updated_at_ms`, and `updated_at` columns. Millisecond timestamps
take precedence over second timestamps when both contain a value. Unknown extra
columns are ignored and therefore do not require an adapter change.

`thread_spawn_edges` is optional. When present it must expose
`parent_thread_id` and `child_thread_id`; optional `status` participates in the
candidate fingerprint but does not change lineage meaning. More than one parent
row for a child is malformed. A supported table records complete immediate
rootward coverage for each thread, including an explicit row absence. A missing
table records unknown lineage coverage even when rollout metadata supplies a
relation; Sessions must not interpret that absence as proof of a root.

The frozen discovery candidate carries this coverage independently of its
optional parent edge. With a supported table, one valid edge or no row may yield
`complete` after rollout metadata consistency succeeds. With no table, a valid
metadata parent/fork relation is still retained, but coverage remains `unknown`.

During explicit indexing, Sessions copies database/WAL bytes into its leased
private workspace, validates a stable generation, and opens only that copy. It
does not open provider SQLite or create provider SHM/sidecars. Unsupported table
capabilities return `unsupported-format`; invalid admitted values return
`malformed`. Both preserve the last-good retained snapshot.

## Record boundary

Each JSONL record must be a plain object with:

- a non-empty string `type`;
- a plain-object `payload`;
- an optional RFC3339 `timestamp`.

Timestamps become UTC with milliseconds. Unlisted fields are ignored and are
not copied or validated. Optional fields accept absence or `null` unless a row
below says otherwise. Supported strings are exact: Sessions does not trim,
case-fold, decode, or Unicode-normalize them.

Every canonical entry records a private logical rollout locator and the decimal
source-record ordinal. Adapter-produced segment metadata is always empty.

Records have three treatments:

1. Supported records validate and project only the listed fields.
2. Deferred and unknown records become one `unknown` entry with one opaque
   omission. No payload content is inspected.
3. Known-skip records emit nothing. No payload content is inspected.

Deferred, unknown, and skipped records break adjacent-message deduplication.

## Evidence mapping

| Evidence                                    | Actor     | Origin      | Confidence |
| ------------------------------------------- | --------- | ----------- | ---------- |
| User text or image                          | `human`   | `human`     | `high`     |
| Assistant, reasoning summary, or tool call  | `model`   | `model`     | `high`     |
| Developer/base/legacy/compacted instruction | `system`  | `injected`  | `high`     |
| System, lifecycle, diagnostic, compaction   | `system`  | `system`    | `high`     |
| Tool result                                 | `tool`    | `tool`      | `high`     |
| Inter-agent message                         | `model`   | `delegated` | `high`     |
| Deferred or unknown record                  | `unknown` | `unknown`   | `unknown`  |

## Outer records

| `type`                               | Consumed payload fields                                                                     | Projection                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `session_meta`                       | `id`; optional `session_id`, `parent_thread_id`, `forked_from_id`, `base_instructions.text` | Metadata, lineage, and optional `injected-context`      |
| `turn_context`                       | optional `turn_id`, `user_instructions`, `developer_instructions`                           | Instruction entries in user-then-developer order        |
| `response_item`                      | payload `type`                                                                              | Response dispatch                                       |
| `event_msg`                          | payload `type`                                                                              | Event dispatch                                          |
| `inter_agent_communication`          | `author`, `recipient`, `content`; optional `encrypted_content`                              | Delegated text, then optional encrypted omission        |
| `compacted`                          | `message`                                                                                   | Compaction marker, then injected context                |
| `inter_agent_communication_metadata` | none                                                                                        | Known skip                                              |
| `world_state`                        | none                                                                                        | Known skip                                              |
| Any other non-empty type             | none                                                                                        | Unknown omission using a safe form of the discriminator |

At least one `session_meta.id` must equal the discovered native thread ID; `id`
is the thread identity. Metadata for another ID is inherited replay context: it
does not emit content or lineage. Optional `session_id` is independently
validated as a non-empty, well-formed group identity shared by a root thread and
its descendants. It may differ from `id`, is not retained or projected, and is
not direct lineage evidence.

A state-database spawn edge is authoritative and produces one high-confidence
`parent` relation. Metadata IDs may only confirm that parent. Without a state
edge, `parent_thread_id` produces a parent relation; otherwise
`forked_from_id` produces a fork relation. Equal repeated relations collapse.
Conflicting current metadata is malformed. Complete or unknown lineage coverage
is admitted only after current metadata passes these consistency checks. Each
current metadata occurrence with base instructions retains its own injected
entry.

## Response items

| Payload `type`                     | Consumed fields                                                          | Projection                     |
| ---------------------------------- | ------------------------------------------------------------------------ | ------------------------------ |
| `message`                          | role; content array; optional `phase`                                    | Canonical message              |
| `agent_message`                    | `author`, `recipient`, content array                                     | Inter-agent message            |
| `reasoning`                        | summary array; optional content array and `encrypted_content`            | Visible summary plus omissions |
| `function_call`                    | non-empty `call_id`, `name`; `arguments`; optional non-empty `namespace` | Tool call                      |
| `function_call_output`             | non-empty `call_id`; string or supported-item-array `output`             | Tool result                    |
| `custom_tool_call`                 | non-empty `call_id`, `name`; `input`; optional non-empty `namespace`     | Tool call                      |
| `custom_tool_call_output`          | non-empty `call_id`; string or supported-item-array `output`             | Tool result                    |
| `compaction`, `compaction_summary` | `encrypted_content`                                                      | Compaction with opaque content |
| `context_compaction`               | optional `encrypted_content`                                             | Compaction marker              |
| `compaction_trigger`               | none                                                                     | Known skip                     |

Message roles map exactly: `user` to human/human, `assistant` to model/model,
`developer` to system/injected, and `system` to system/system. The optional
phase must be `commentary` or `final_answer`; it does not change the projection.

### Nested content

| Parent                               | Supported item                                 | Segment                                                 |
| ------------------------------------ | ---------------------------------------------- | ------------------------------------------------------- |
| Message content                      | `input_text`, `output_text` with string `text` | Exact text                                              |
| Message content                      | `input_image` with string URL and valid detail | Omitted `image` / `input-image`; URL discarded          |
| Agent-message content                | `input_text` with string `text`                | Exact delegated text                                    |
| Agent-message content                | `encrypted_content` with encrypted string      | Omitted `unknown` / `encrypted-agent-content`           |
| Reasoning summary                    | `summary_text` with string `text`              | Exact visible reasoning-summary text                    |
| Reasoning content                    | `reasoning_text` or `text` with string text    | Omitted `unknown` / `reasoning-content`; text discarded |
| Tool-result output                   | `input_text` with string `text`                | Exact tool text                                         |
| Tool-result output                   | `input_image` with string URL and valid detail | Omitted `image` / `input-image`; URL discarded          |
| Tool-result output                   | `encrypted_content` with encrypted string      | Omitted `unknown` / `encrypted-tool-content`            |
| Unknown message/agent/reasoning item | Any other non-empty item type                  | Omitted `unknown` / `unknown-content-item`              |
| Unknown result item                  | Any other non-empty item type                  | Omitted `structured` / `unknown-content-item`           |

Valid image detail values are `auto`, `low`, `high`, and `original`. Array order
is canonical segment order. Empty call inputs and string results remain exact
text segments; an empty result array remains a tool result with zero segments.

Reasoning segments are ordered: summary, hidden-content omissions, then the
encrypted omission. Encrypted reasoning uses `encrypted-reasoning` and encrypted
compaction uses `encrypted-compaction`.

### Deferred response items

These types become one opaque unknown omission:

`additional_tools`, `local_shell_call`, `tool_search_call`,
`tool_search_output`, `web_search_call`, `image_generation_call`.

Every other unsupported non-empty response type receives the same safe unknown
treatment.

## Event messages

| Payload `type`                         | Consumed fields                                                                          | Projection                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `user_message`                         | `message`; optional nullable string-array `images`; optional string-array `local_images` | Human text, remote-image omissions, local-image omissions |
| `agent_message`                        | `message`                                                                                | Model message                                             |
| `agent_reasoning`                      | `text`                                                                                   | Reasoning summary                                         |
| `task_started`, `turn_started`         | non-empty `turn_id`                                                                      | Turn-started marker                                       |
| `task_complete`, `turn_complete`       | non-empty `turn_id`; optional nullable error object with string `message`                | Turn-completed marker, then optional diagnostic           |
| `turn_aborted`                         | optional nullable non-empty `turn_id`; supported `reason`                                | Turn-aborted marker                                       |
| `thread_rolled_back`                   | unsigned 32-bit integer `num_turns`                                                      | Rollback marker; count not retained                       |
| `context_compacted`                    | none                                                                                     | Compaction marker                                         |
| `error`, `warning`, `guardian_warning` | `message`                                                                                | Diagnostic                                                |
| `stream_error`                         | `message`; optional `additional_details`                                                 | Ordered diagnostics                                       |
| `deprecation_notice`                   | `summary`; optional `details`                                                            | Ordered diagnostics                                       |

Abort reasons are `interrupted`, `replaced`, `review_ended`, and
`budget_limited`. Start and terminal markers relate only through an exact turn
ID. A completion marker never asserts task success.

Remote images become `image` / `input-image`; local images become `image` /
`local-image`. Neither URL nor path is retained.

### Deferred events

These types become one opaque unknown omission:

`mcp_tool_call_begin`, `mcp_tool_call_end`, `web_search_begin`,
`web_search_end`, `image_generation_begin`, `image_generation_end`,
`exec_command_begin`, `exec_command_end`, `view_image_tool_call`,
`dynamic_tool_call_request`, `dynamic_tool_call_response`,
`patch_apply_begin`, `patch_apply_end`, `entered_review_mode`,
`exited_review_mode`, `item_completed`, `collab_agent_spawn_begin`,
`collab_agent_spawn_end`, `collab_agent_interaction_begin`,
`collab_agent_interaction_end`, `collab_waiting_begin`,
`collab_waiting_end`, `collab_close_begin`, `collab_close_end`,
`collab_resume_begin`, `collab_resume_end`, `sub_agent_activity`.

No ignored field can backfill a supported call, result, or lineage relation.

### Known-skip events

These types emit no canonical entry:

`realtime_conversation_started`, `realtime_conversation_realtime`,
`realtime_conversation_closed`, `realtime_conversation_sdp`, `model_reroute`,
`model_verification`, `turn_moderation_metadata`, `safety_buffering`,
`thread_settings_applied`, `token_count`, `agent_reasoning_raw_content`,
`agent_reasoning_section_break`, `session_configured`, `thread_goal_updated`,
`mcp_startup_update`, `mcp_startup_complete`, `exec_command_output_delta`,
`terminal_interaction`, `exec_approval_request`, `request_permissions`,
`request_user_input`, `elicitation_request`, `apply_patch_approval_request`,
`guardian_assessment`, `patch_apply_updated`, `turn_diff`,
`realtime_conversation_list_voices_response`, `plan_update`,
`shutdown_complete`, `raw_response_item`, `raw_response_completed`,
`item_started`, `hook_started`, `hook_completed`,
`agent_message_content_delta`, `plan_delta`, `reasoning_content_delta`,
`reasoning_raw_content_delta`.

Every other unsupported non-empty event type receives the safe unknown
treatment.

## Linkage and duplicates

- A call ID can identify at most one supported call and one supported result.
  Duplicates are malformed. Results link to the exact matching call across the
  complete rollout, including result-before-call. Unmatched evidence remains
  present and unlinked. Results never inherit tool name or namespace.
- Only physically adjacent, cross-family response/event messages can collapse.
  Actor, timestamp presence/value, and every ordered text or omission segment
  must match exactly, including origin and confidence. Sessions retains the
  response item and its locator.
- Same-family, non-adjacent, or partially different messages remain separate.
  Ignored, unknown, and blank records break adjacency.
- Every compaction representation remains separate.
- Equal text never creates a fork, replay, delegation, parent, or tool call.

## Safe unknown discriminators

Only a format-level structural discriminator can become an omission source
type. It must be at most 64 UTF-8 bytes and match
`^[a-z0-9]+(?:[_-][a-z0-9]+)*$`. Sessions replaces `_` with `-` and validates the
canonical kebab token again. Unsafe paths, URLs, controls, uppercase text,
Unicode, repeated separators, and oversized values become the static
`unknown-record` token. Unknown nested items always use the static
`unknown-content-item` token.

Adding a new interpreted variant requires an implementation, fixture, and this
support document to change together.
