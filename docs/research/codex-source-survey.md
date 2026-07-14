# Codex source survey

- Status: pre-M5 research baseline
- Date: 2026-07-14
- Scope: first-party Codex source adapter

## Purpose

Record what Codex currently stores, which inputs Sessions should trust, and
which Harness behavior is useful reference material before the first adapter is
planned. This survey informs the architecture and roadmap; the provider-neutral
contracts remain authoritative.

The local inspection was structural and read-only. It recorded schemas, counts,
file sizes, record kinds, and linkage shapes. It did not copy titles, prompts,
transcript text, workspace paths, identifiers, credentials, or attachment data
into this repository.

## Evidence used

- The current standalone domain, source-port, indexing, storage, privacy, and CLI
  contracts.
- The pinned public
  [Harness Codex implementation](https://github.com/ferueda/harness/tree/fead436b9c810c3f0a3952789f0716765ddbc8f9/skills/sessions/lib/codex)
  and its tests, treated as experience rather than a target architecture.
- Pinned upstream Codex source for
  [Codex-home resolution](https://github.com/openai/codex/blob/d7ba5ff9553a6aa0898a8e3bd5cb3bc00d0c9ddf/codex-rs/utils/home-dir/src/lib.rs#L5-L60),
  [SQLite-home precedence](https://github.com/openai/codex/blob/d7ba5ff9553a6aa0898a8e3bd5cb3bc00d0c9ddf/codex-rs/core/src/config/mod.rs#L3774-L3779),
  [rollout compression](https://github.com/openai/codex/blob/d7ba5ff9553a6aa0898a8e3bd5cb3bc00d0c9ddf/codex-rs/rollout/src/compression.rs#L18-L57),
  [response items](https://github.com/openai/codex/blob/d7ba5ff9553a6aa0898a8e3bd5cb3bc00d0c9ddf/codex-rs/protocol/src/models.rs#L997-L1080),
  and the
  [rollout protocol](https://github.com/openai/codex/blob/d7ba5ff9553a6aa0898a8e3bd5cb3bc00d0c9ddf/codex-rs/protocol/src/protocol.rs#L3028-L3272).
- A sanitized structural survey of one active `~/.codex` installation. It had a
  four-digit thread catalog and more than 3 GiB of rollout data, including
  individual rollouts larger than 100 MiB. Those scale observations justify
  streaming; they are not format guarantees or committed fixtures.

## Source inventory and authority

| Source                                      | V1 role                                           | Decision                                                                     |
| ------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| Active `state_5.sqlite`                     | Discovery, metadata, rollout locator, parent edge | Required, read-only                                                          |
| Referenced `.jsonl` or `.jsonl.zst` rollout | Transcript and event content                      | Required, streamed read-only                                                 |
| `thread_spawn_edges`                        | Exact child-to-parent lineage                     | Include relevant row or explicit absence                                     |
| `thread_dynamic_tools`                      | Available-tool catalog                            | Exclude as invocation evidence; reconsider only for labeled catalog analysis |
| `logs_2.sqlite`                             | Operational logs                                  | Exclude; large, duplicative, and not transcript authority                    |
| `memories_1.sqlite`                         | Derived summaries and jobs                        | Exclude from canonical transcript evidence                                   |
| `goals_1.sqlite`                            | Feature-specific goal state                       | Exclude from V1                                                              |
| `agent_jobs` / `agent_job_items`            | Batch-job bookkeeping                             | Exclude from V1; not the per-turn task lifecycle                             |
| App UI databases                            | Automations, inbox, and local catalog state       | Exclude from the source adapter                                              |
| `session_index.jsonl` / `history.jsonl`     | Secondary indexes or history                      | Exclude; do not duplicate or replace the state/rollout pair                  |
| Referenced attachments                      | Non-text user/tool inputs                         | Never read or copy binaries in V1; preserve only an ordered omitted segment  |

The state database is the discovery catalog, not transcript content authority.
The referenced rollout is the content source. V1 requires both. A missing or
unreadable state database produces a typed unavailable/unreadable result rather
than silently scanning the filesystem and changing discovery semantics.

Those sources are capture authority, not retention or deletion authority. After
a successful canonical capture, a later complete state scan that omits the
thread marks the Sessions copy missing and retains it. Missing/corrupt state or
incomplete discovery proves no thread absence. The Codex adapter reports only
source evidence; the provider-neutral engine owns that lifecycle.

Use one active state root. Do not merge root and legacy databases: an installation
can retain a stale nested database beside the current root database.

## Observed state model

The active state database was WAL-backed and had migrations through schema 40.
Implementations must feature-detect required and optional columns rather than
assuming that observed version.

The surveyed installation also retained a nested legacy state database. The
active root catalog had 1,225 thread rows and current WAL activity; the nested
catalog had 364 rows and an older migration level. This is concrete evidence for
root precedence and against merging catalogs.

`threads` contains the durable discovery row. Its fields cover:

- native thread ID and rollout path;
- created/updated time, title, preview, workspace, and archive state;
- source, thread source, model/provider, CLI version, and token usage;
- sandbox/approval settings and Git metadata;
- agent role/path and recurrence/history metadata.

Only fields that affect canonical output belong in the logical input
fingerprint. Optional fields degrade to absent/unknown.

`thread_spawn_edges(parent_thread_id, child_thread_id, status)` supplies exact
spawn lineage. The child record should retain a `parent` relation; inverse child
lookup is query behavior, not duplicated source evidence. Text similarity never
creates lineage.

`thread_dynamic_tools` describes tools made available to some threads. Catalog
presence is mention/availability evidence, not proof of a call. Invocation comes
only from a source-native rollout call event.

`agent_jobs` and `agent_job_items` describe a separate batch-job subsystem. The
rollout's `task_started`, `task_complete`, and abort records describe turn
lifecycle. A `task_complete` record terminates a turn; it does not prove task
success.

### Sanitized schema snapshot

Only column names and structural roles are recorded here:

| Table                  | Observed columns                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `threads`              | `id`, `rollout_path`, `created_at`, `updated_at`, `source`, `model_provider`, `cwd`, `title`, `sandbox_policy`, `approval_mode`, `tokens_used`, `has_user_event`, `archived`, `archived_at`, `git_sha`, `git_branch`, `git_origin_url`, `cli_version`, `first_user_message`, `agent_nickname`, `agent_role`, `memory_mode`, `model`, `reasoning_effort`, `agent_path`, millisecond timestamps, `thread_source`, `preview`, recency fields, `history_mode` |
| `thread_spawn_edges`   | `parent_thread_id`, `child_thread_id`, `status`                                                                                                                                                                                                                                                                                                                                                                                                           |
| `thread_dynamic_tools` | `thread_id`, `position`, `name`, `description`, `input_schema`, `defer_loading`, `namespace`                                                                                                                                                                                                                                                                                                                                                              |
| `agent_jobs`           | ID/name/status, instruction/schema/input/output paths, timestamps, error, maximum runtime                                                                                                                                                                                                                                                                                                                                                                 |
| `agent_job_items`      | job/item IDs, source row, status, assigned thread, attempts, result, error, timestamps                                                                                                                                                                                                                                                                                                                                                                    |

The survey found 352 spawn edges, sparse dynamic-tool catalogs, and no batch job
rows. These are installation observations, not assumptions for fixtures.

Auxiliary schemas reinforce their exclusion: logs store timestamped operational
records; goals store objectives and budgets; memories store derived raw memory
and rollout summaries; and the app database stores automations, inbox data, and
a secondary thread catalog. None replaces the state-row/rollout pair.

## Observed rollout model

Current rollouts are JSONL and Codex can transparently replace cold files with
`.jsonl.zst`. Node.js has exposed streaming Zstandard transforms since 22.15;
the Sessions minimum of 24.16 can therefore support both representations through
`node:zlib` without another runtime dependency.

The surveyed corpus contained these structural families:

- `session_meta`, `turn_context`, `world_state`, compaction, and inter-agent
  metadata;
- user, assistant, developer, and system messages;
- function, custom, MCP/dynamic, tool-search, and web-search calls/results;
- task start/complete, abort, rollback, compaction, patch, and sub-agent events;
- visible reasoning summaries, opaque/encrypted reasoning, images, and snapshots.

The format has evolved across CLI versions. Unknown optional records must be
skippable and observable through sanitized diagnostics. A malformed supported
record is a typed failure. An incomplete final record is `source-changed` when
the physical input changed during the read; otherwise it is malformed.

The sanitized multi-version sample supplied several design checks:

- 36,030 call/result pairs were structurally linked; 22,536 were non-adjacent,
  so adjacency cannot define tool linkage;
- 1,843 sampled calls carried namespaces, and seven tool names occurred under
  more than one namespace;
- 2,148 task starts, 2,082 matching completions, 65 aborts, and 16 starts without
  a terminal record showed that lifecycle can remain incomplete;
- 14,622 of 14,632 nearby exact cross-representation message pairs were adjacent,
  supporting only the conservative duplicate rule below;
- image and local-image input records confirmed that a text-only canonical model
  would silently lose evidence.

These counts describe one structural sample, not protocol guarantees or product
metrics.

### Duplicate representations

Codex can record the same message in adjacent event and response-item forms. In
the surveyed sample, almost every exact cross-source duplicate within a short
window was adjacent. Collapse only an adjacent, structurally recognized pair.
Preserve same-source repeats and non-adjacent equal text; broad text deduplication
would erase real recurrence.

### Tool evidence

Calls and results can be non-adjacent and link by provider call ID. Results may
be strings or ordered structured item arrays. Preserve ordered textual
arguments/results and exact linkage. An unmatched call remains a call; an
unmatched result remains a result without fabricated linkage or status.

Codex tool identity has both an exact name and an optional exact namespace. The
survey found the same name under multiple namespaces. The generic model must
therefore retain optional `toolNamespace` beside `toolName`; concatenating the
two or hiding the namespace in adapter metadata would make exact queries lossy.
Results link to calls but do not duplicate either identity field.

### Messages, markers, and omitted state

- Preserve user/assistant/developer/system text with evidence-backed actor and
  origin. Recognized injected blocks remain classified content; do not strip
  them.
- Preserve user-visible reasoning summaries only when the source explicitly
  exposes them as such. Never decrypt or invent opaque/hidden reasoning.
- Normalize compaction, rollback, abort, and turn lifecycle as markers. Do not
  reinterpret completion as success.
- Preserve explicit inter-agent communication and delegated origin when the
  source proves it.
- Omit world state, ghost snapshots, encrypted reasoning, replacement history,
  and unsupported opaque payloads from canonical text. Their omission belongs in
  the format-support matrix.
- Do not read or store attachment bytes, data URLs, remote URLs, or local
  attachment paths. Preserve an ordered provider-neutral omitted segment with
  broad class, provenance, and the canonical bounded source-type token defined by
  the architecture contract. It has no text or hash and does not participate in
  FTS, deduplication, or recurrence.

### Replay and lineage

Spawned, forked, and compacted rollouts can contain inherited or replayed
history. Use state edges and explicit session metadata for lineage. Classify
content as replayed/copied only where the source proves a boundary; equal text
alone is insufficient. Repeated `session_meta` records do not create additional
canonical sessions.

## Path resolution contract for M5

Codex resolves its home from non-empty `CODEX_HOME`, otherwise `~/.codex`. An
explicit home must exist and be a directory and is canonicalized; a literal `~`
is not expanded. Its effective SQLite home prefers top-level `sqlite_home` from
the global `$CODEX_HOME/config.toml`, then non-empty `CODEX_SQLITE_HOME`, then
Codex home. The environment value can be relative to the resolved working
directory. Config path semantics must use a real TOML parser, not regex.

The first adapter must:

1. resolve and canonicalize one Codex home and one global/default SQLite home
   without mutation;
2. use `state_5.sqlite` in that effective SQLite home;
3. use `sqlite/state_5.sqlite` only as a legacy fallback when neither config nor
   environment selected a SQLite home and the Codex-home root database is
   absent;
4. never fall back from an explicit missing path or corrupt primary database and
   never merge roots;
5. derive a stable source-instance ID from the resolved source roots without
   exposing private paths as public identity;
6. accept only regular `rollout-*.jsonl` or `.jsonl.zst` files whose thread-ID
   suffix matches and whose canonical path stays under
   `$CODEX_HOME/sessions` or `$CODEX_HOME/archived_sessions`; reject traversal,
   symlink escape, and unrestricted absolute paths;
7. normalize plain and compressed representations to one logical rollout
   identity. Plain wins if both exist; a representation transition during read
   is `source-changed`;
8. document that V1 resolves the global/default Codex instance. System, cloud,
   profile, project, and runtime config-layer parity and explicit multiple Codex
   instances remain later work.

The persistent source-instance preimage is exact. After the path rules above,
serialize with unspaced `JSON.stringify`:

```json
[
  "sessions-codex-source-instance-v1",
  ["codex-home", "<resolved-codex-home>"],
  ["sqlite-home", "<resolved-sqlite-home>"]
]
```

Hash those exact UTF-8 bytes with SHA-256 and prefix the lowercase hex digest
with `local-sha256-v1:`. Do not perform additional case folding, separator
conversion, or Unicode normalization. This versioned role-tagged tuple is the
identity contract; config provenance, state filename, rollout roots, and adapter
version are not part of it.

M5 should add a small typed ESM TOML parser only after the roadmap's production-
dependency review. `smol-toml` is the current candidate. Node supplies Zstandard
streaming and SQLite, so neither needs a new package.

## Fingerprint and mutation contract

Never fingerprint the SQLite database file as a whole. WAL content and unrelated
thread changes would either be missed or invalidate every session.

For each candidate, declare independent ordered inputs:

- a canonical logical fingerprint of the whitelisted thread-row fields;
- the exact parent-edge row, or an explicit absence sentinel;
- the selected rollout representation and a robust physical descriptor.

Do not give SQLite a provider-owned state path: even a read-only WAL connection
can coordinate through provider SHM. M5 first copies a cryptographically
pre/post-verified stable database/WAL byte set from the same validated read-only
filesystem handles into a random private directory granted by the leased
provider-neutral discovery workspace. Its hidden root is the exact Sessions-
owned `.scratch` path; the adapter sees neither that root nor `IndexPaths`. It
then opens only that private copy read-only/query-only so SQLite
can rebuild only a private SHM. Provider SHM is derived coordination state and is
neither opened, copied, nor used to gate capture; otherwise unrelated provider
read marks could cause false retries. This reads committed live WAL state without
provider writes; direct immutable opens are not authoritative for that state.

One capture per complete discovery materializes all admitted thread/edge values
into an adapter-private immutable generation map, then closes SQLite and removes
the staging child before yielding. Candidate reads require matching frozen
descriptors and never recopy or reopen state. Stream only the rollout as a live
input and verify its representation and physical descriptor before and after
consumption. Any stale candidate or rollout mismatch is `source-changed`; no
partial document reaches the index. Tests must prove the provider database/WAL/
SHM bytes and identity/mtime/ctime metadata remain unchanged and that any created
sidecar exists only under private staging.

The staging copy is ephemeral execution state, not a retained raw-provider
backup. Normal completion removes it in `finally`; writer close attempts to
remove the empty root before releasing its lease. An abrupt process/host crash or
surfaced cleanup failure can leave raw
state bytes in the permission-restricted Sessions-owned subtree until the next
leased index sweep or explicit data clear. A concurrent writer/checkpointer/WAL-
reset stress gate must prove that every accepted copy equals one complete
committed cross-table generation. This raw-copy protocol is not an SQLite backup
guarantee; failure of that gate fails closed and never falls back to opening the
provider database.

This design follows SQLite's distinction between persistent WAL frames and the
derived shared-memory WAL index, and its warning that `immutable=1` asserts the
underlying file will not change. SQLite's supported online-backup API requires a
source connection, which would reintroduce provider SHM coordination here. The
raw-copy acceptance window therefore remains explicitly conditional on the
stress gate rather than being described as an SQLite-supported backup:
[WAL](https://sqlite.org/wal.html),
[WAL format](https://sqlite.org/walformat.html),
[online backup](https://sqlite.org/backup.html), and
[URI `immutable`](https://sqlite.org/uri.html).

## Harness reuse boundary

Keep as reference behavior:

- Codex-home resolution and deliberate root/legacy state lookup;
- read-only thread-row and spawn-edge access;
- conservative adjacent event/response duplicate handling;
- malformed-source and schema-compatibility fixture ideas.

Do not port:

- whole-file `readFileSync` parsing;
- tool calls flattened into display text;
- loss of call IDs, namespace, structured results, timestamps, or markers;
- injected-preamble deletion;
- provider-owned cache writing, classifications, filters, or workflow policy;
- show/query paths that reopen mutable rollouts.

The standalone parser should be written against the canonical contract and a
new synthetic format matrix. Harness proves useful workflows and a few source
behaviors; it is not the normalization specification.

The scoped M5 plan intentionally closes a smaller first format revision than the
full observed corpus. It maps messages, explicit inter-agent text, visible
reasoning summaries, function/custom calls and results, compaction, lifecycle,
and diagnostics. Exact local-shell, dynamic/MCP, tool-search, web-search,
image-generation, exec, patch, review, collaboration, and sub-agent
discriminators remain visible as privacy-safe unknown evidence without inspecting
their payloads. This deferral tests forward compatibility without freezing
speculative mappings; later adapter-format increments can promote one family at a
time with pinned fixtures.

## M5 pre-implementation gates

The scoped M5 executor plan must settle and test:

- ordered text/omitted content through M5 domain/storage/list-show behavior plus
  accepted semantics for the M6 query and M7 DTO work;
- optional exact `toolNamespace` through M5 domain/storage behavior plus accepted
  M6 filter and M7 DTO semantics;
- global config/environment/default SQLite-home precedence and legacy fallback;
- streaming JSONL/Zstandard parsing and bounded per-record memory;
- required versus optional state-schema fields;
- the logical state-row/edge and physical rollout fingerprint schemes;
- durable capture metadata, present/missing/unknown source observation, and
  post-reconciliation retention without adapter-owned policy;
- a record-by-record support/omission matrix;
- synthetic fixtures for path precedence, legacy lookup, compressed rollouts,
  adjacent paired messages, every supported call/result family, every exact
  deferred and skipped discriminator treatment, structured results, injected
  content, non-text content, lineage/replay, lifecycle markers, unknown records,
  malformed input, and live source mutation.

No personal provider database or rollout becomes a committed fixture.
