# Cursor source survey

- Status: historical pre-M11 research baseline; M11a prerequisite implemented
- Date: 2026-07-16
- Scope: passive local Cursor adapter and its provider-neutral prerequisite

## Purpose

Record what current Cursor products promise, what one current local installation
actually stores, which inputs Sessions should trust, and which Harness behavior
is useful reference material before M11 is planned. This survey informs the
architecture and roadmap; the provider-neutral source, privacy, indexing, and
canonical evidence contracts remain authoritative.

The local inspection was structural and read-only. It recorded versions, paths,
schemas, aggregate counts, record kinds, and linkage shapes. It did not copy
titles, prompts, transcript text, workspace paths, identifiers, credentials,
tool arguments/results, or attachment data into this repository.

## Conclusion

Cursor should remain one passive `cursor` source kind with a small set of
adapter-owned, structurally detected local format readers. It should not call
Cursor APIs, install hooks, fetch shared links, or infer missing evidence from
product behavior.

Current Cursor storage also proved that the internal source port needed one small
provider-neutral prerequisite before the adapter can be implemented safely and
efficiently. Richer conversation evidence needed for faithful capture lives in
WAL-active per-session SQLite stores, although the exact reconstruction and
authority rules still require fixture-backed proof. At survey time, the port gave
private staging to `discover(workspace)` but not to `read(candidate)`. M11a has
since generalized that workspace to changed reads. Without it, a complete Cursor
implementation would have had to choose between:

- copying and materializing more than a thousand databases during every
  discovery, including stable runs;
- opening live provider databases and participating in provider SHM state; or
- using reduced JSONL transcripts that omit richer tool-result/linkage evidence
  and do not cover every current local conversation family.

The smallest correction is to make the existing opaque workspace a source
capture capability and pass it explicitly to changed-session reads. Discovery
stays cheap. Only a candidate that the shared engine considers changed receives
a private main/WAL snapshot. This changes the internal adapter port, not the
domain, repository, query, CLI, JSON/JSONL, Agent Skill, or provider-read-only
contract.

## Evidence used

- The current standalone project intent, source adapter contract, indexing flow,
  privacy contract, Codex implementation, and shared source conformance suite.
- The pinned public
  [Harness Cursor implementation](https://github.com/ferueda/harness/tree/2fd718929e98c2e4ff27a5d5e63babe37bb8ae2f/skills/sessions/lib/cursor)
  and its fixtures/tests, treated as prior experience rather than a target
  architecture.
- Current official Cursor documentation and dated changelogs listed in
  [Official sources](#official-sources).
- A sanitized structural survey of one active macOS Cursor 3.12.10 installation.
  Counts describe that installation on 2026-07-16; they are scale and format
  evidence, not cross-version guarantees or committed fixtures.

## Official product model

Cursor now exposes several conversation and execution surfaces. Their product
semantics guide normalization, but do not define the undocumented local storage
encoding.

### Conversations and execution locations

- The Agents Window spans local, worktree, cloud, remote SSH, and multi-workspace
  use. A workspace, branch, or worktree is context, not stable session identity.
- Local conversation search builds a local index over past agent transcripts.
  That proves a local transcript corpus exists, not that its schema is public or
  stable.
- Historical History documentation says foreground Agent history is local
  SQLite while Background Agent history is remote. Current Cloud Agent
  documentation continues to describe remote execution and state. M11 must not
  equate a successful local scan with complete Cursor-account coverage.
- Cursor CLI documents stable session IDs and a structured live `stream-json`
  event format. That is a useful semantic reference, but it is not a documented
  passive on-disk history format.

### Side chats

Side chats introduced in Cursor 3.11 are local-only durable child conversations.
They remain attached to their parent and workspace, but contain only their own
visible transcript. The parent history is hidden reference context. A side chat
is explicitly not a fork, closing archives rather than deletes it, and nested
side chats are not supported.

Sessions should therefore:

- admit a locally complete side chat as an independent canonical session;
- preserve an exact parent relation only when local storage supplies the parent
  ID;
- never copy parent entries into the child or synthesize hidden context; and
- never infer a parent from similar text, UI placement, directory names, or a
  side-chat label.

### Subagents, tools, and compaction

Current Hooks documentation defines stable conversation IDs, per-user-message
generation IDs, tool call/result IDs, subagent lifecycle fields, separate
subagent transcript paths, and compaction events. Hooks are optional live
instrumentation, not a required passive source. They are a semantic oracle only
where local persisted evidence uses the same fields.

Current product documentation also says older conversation context can be
compacted into summaries and that subagents have separate context. Sessions may
capture observed summaries, thoughts, plans, tool calls, results, and subagent
messages when serialized. It must not reconstruct omitted pre-compaction turns,
hidden prompts, rules, skills, MCP catalogs, or parent context.

## Sanitized local inventory

| Local source family                               | Aggregate evidence                      | Proposed role                                             |
| ------------------------------------------------- | --------------------------------------- | --------------------------------------------------------- |
| `~/.cursor/chats/<scope>/<chat>/meta.json`        | 330 valid metadata files                | Chat discovery and exact optional metadata                |
| `~/.cursor/chats/<scope>/<chat>/store.db`         | 312 blob stores, all with WAL/SHM       | Current local chat content, including rich tool evidence  |
| `~/.cursor/projects/**/agent-transcripts/*.jsonl` | 1,717 transcripts                       | Efficient but reduced agent transcript evidence           |
| `sdk-agent-store/**/agents/<agent>/store.db`      | 892 blob stores, active WAL/SHM common  | Rich agent content and tool/result evidence               |
| Project `index.db`                                | 41 catalogs with agent/run/event tables | Exact lifecycle/discovery metadata and possible relations |
| App Support composer headers                      | Legacy/global header records            | Narrow legacy supplement only                             |
| App Support opaque KV, caches, logs, tracking     | Multiple unrelated/derived stores       | Exclude unless a later format branch proves authority     |

### Chat store version 1

Every observed `meta.json` contained `schemaVersion`, `createdAtMs`,
`updatedAtMs`, and `hasConversation`. Some also contained `cwd` or `title`.
Directory identity remains the discovery address; metadata can enrich it but
must not replace or silently conflict with an exact provider identity.

The observed SQLite schema was version 1 with only:

```sql
CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
```

The metadata root was hex-encoded JSON containing observed fields such as agent
identity, creation time, mode, name, and a latest root blob ID. Observed modes
included default, search, and plan. Historical/current mode strings should be
treated as opaque provider evidence rather than a closed enum.

Sampled message blobs contained system, user, assistant, and tool roles. Content
included text, tool calls, tool results, exact tool names/call IDs, and redacted
reasoning. No explicit side-chat parent field was found in the sample, so the
official parent semantics cannot yet be projected as local lineage.

Two main database files were empty/version 0 while active WAL/SHM existed. A
main-file-only immutable open is therefore not a complete capture strategy.

### Agent JSONL version 1

The current agent transcript corpus used user and assistant message records plus
`turn_ended` records with status/error evidence. Message content contained text
and tool-use parts. Across the surveyed corpus, no tool-result content part was
observed in this JSONL family, while the blob stores contained tool results and
linkage.

The filename alone is not a globally safe native identity:

- 618 filenames had UUID form;
- 1,099 used an `agent-` prefix;
- 7 filename groups appeared in multiple project roots; and
- all 7 duplicate groups had different transcript bytes.

M11 must resolve exact identity from structurally owned metadata/catalog state
or use a proven provider-scoped identity. It must not globally join metadata by
bare filename, project traversal order, title, timestamp, digest, or text.

### Agent blob store and project catalog

The 892 observed per-agent stores used the same blob/meta schema and richer
message model as chat stores. Seven main files were empty while WAL/SHM was
active. Sampled root pointers could not be resolved from immutable main-file
reads, which directly proves that WAL state is required for current agent
capture.

Project `index.db` catalogs exposed:

- agents: agent ID, workspace reference, status, active run, checkpoint, name,
  metadata, and timestamps;
- runs: run/request/agent IDs, turn number, status, model, checkpoints, errors,
  usage/result references, and lifecycle timestamps; and
- ordered run events: run ID, sequence/offset, event type, payload/reference,
  idempotency key, and timestamp.

The catalog is useful for exact discovery, lifecycle metadata, and any relation
that its records explicitly prove. It is not a substitute for transcript
content, and workspace references must not define identity or leak through
public output.

### Legacy and unrelated state

App Support composer headers exposed historical composer/workspace IDs,
timestamps, archive/recency state, subagent flags, and checkpoint references.
They may support a narrow declared legacy branch or supplement exact metadata.
The large opaque item/KV stores require independent structural proof before use.

AI code tracking, checkpoints, browser/cache/log stores, process monitoring,
and similar state are not canonical conversation sources. Plans, rules, memories,
checkpoints, and referenced files are not crawled independently merely because
the product can inject or display them. Only their exact observed transcript
representation is eligible.

## Source authority and coverage

One `cursor` adapter should hide a small, documented set of internal reader
branches. Suggested internal labels are descriptive only, not public source
kinds:

- `chat-store-v1`;
- `agent-jsonl-v1`;
- `agent-blob-store-v1`; and
- `composer-state-v1` for a narrowly proven legacy supplement.

Each branch needs:

- a structural discriminator and required/optional inputs;
- one exact identity and field-authority rule;
- a fixed parser and adapter version;
- complete ordered input fingerprints; and
- a typed `unsupported-format` outcome when a recognized candidate reaches
  `read`; a discovery-family incompatibility instead makes the discovery
  generation incomplete.

When several stores describe one conversation, the adapter must consolidate them
before yielding and apply a documented field-by-field authority rule. It must
not pick the newest, longest, first, or most textually similar representation.
Unresolved competing transcript authorities or duplicate identities make the
discovery generation incomplete.

M11 local coverage should include only physically present formats that prove
exact identity and complete local content. Target families, conditional on that
proof, are:

- Editor and Agents Window parent conversations;
- side chats as independent sessions;
- local subagents as independent sessions;
- local worktree and multi-root sessions; and
- Cursor CLI sessions if their durable local representation is proven.

If a target family cannot meet that proof bar, its omission remains an explicit
coverage gap rather than inferred or partial evidence.

M11 excludes cloud-only, mobile/web-only, automation-triggered remote, shared
link, and remote-machine-only histories. It performs no Cursor authentication or
network call. A local stub or handoff record does not authorize invented cloud
entries.

## Harness reference boundary

The Harness implementation is useful evidence for:

- recursive `agent-transcripts` discovery;
- observed JSONL role/content variants;
- `meta.json` and historical blob metadata shapes;
- transcript-only sessions and missing optional metadata;
- malformed JSON, missing files, multiple user turns, and hyphenated project-key
  fixtures.

Do not port:

- its JSONL metadata cache or provider-file reopening for later queries;
- its closed provider factory or `auto` selection policy;
- default automation/subagent exclusions and prompt/ID classification;
- injected-block deletion;
- first-query-derived titles;
- lossy project-key-to-workspace decoding;
- best-effort swallowing of present-but-corrupt metadata;
- unbounded opaque blob scans; or
- flattening that loses non-text parts, tool identity/linkage, timestamps,
  provenance, and lineage.

The standalone engine durably owns canonical snapshots. The adapter only
discovers and normalizes source evidence.

## Implemented provider-neutral prerequisite

At survey time, the source port gave `SourceDiscoveryWorkspace` only to discovery.
`discoverSessions` exhausts the entire generation before freshness checks and
changed reads begin. Cursor therefore cannot retain a discovery callback's
temporary database snapshot for a later read, and it should not secretly capture
the workspace object outside the declared port contract.

M11a renamed/generalized that capability to `SourceCaptureWorkspace` and now
passes it to both operations:

```ts
interface SessionSource {
  discover(workspace: SourceCaptureWorkspace): AsyncIterable<DiscoveredSession>;
  read(candidate: DiscoveredSession, workspace: SourceCaptureWorkspace): Promise<SessionDocument>;
}
```

The existing infrastructure already creates random mode-hardened private
attempt directories, checks writer-lease ownership around allocation/cleanup,
removes attempts in `finally`, and removes the scratch root before writer
release. The prerequisite should expose no path, lease identity, storage handle,
or durable cache to the adapter.

With that prerequisite in place, the planned Cursor flow is:

1. Discover exact identities and fingerprint complete physical inputs without
   parsing every transcript or copying databases.
2. Let the shared repository freshness check skip unchanged candidates.
3. For a changed candidate, use the passed workspace to copy and verify only its
   required main/WAL inputs.
4. Open only the private copy and let SQLite create private SHM there.
5. Materialize and normalize the complete candidate, then clean the attempt
   before returning.
6. Return `source-changed` when any input changes around capture; use the existing
   bounded fresh-rediscovery retry.

Physical WAL/checkpoint changes may conservatively cause a reread even when
logical content is equal. That cost is acceptable; silently missing committed
evidence is not.

### Rejected alternatives

- **Materialize every database during discovery:** correct but makes every stable
  run copy/decode more than a thousand stores and reverses M10's proportional
  indexing work.
- **Open provider SQLite read-only:** WAL access can use provider SHM;
  `immutable=1` ignores required WAL state.
- **Parse SQLite WAL directly:** couples the adapter to SQLite page/WAL internals
  and is much larger than using SQLite on a verified private copy.
- **Add an adapter cache:** crosses persistence/invalidation ownership and creates
  a second source of truth.
- **Use JSONL only:** misses current chat stores and observed tool-result/linkage
  evidence.
- **Retain the discovery workspace secretly:** hides a real capability outside
  the port signature and weakens conformance/cleanup proof.

## M11 normalization rules

- Use exact provider conversation/agent identity. Never use title, workspace,
  branch, worktree, timestamp, transcript digest, or bare non-unique filename as
  identity.
- Fingerprint every metadata, catalog, transcript, main database, and WAL input
  that affects canonical output. Do not fingerprint SHM as canonical content or
  open provider SHM.
- Preserve exact source-observed user/model/system/injected text. Split wrapper
  blocks only when a declared record shape proves they were injected; a user who
  types similar tags must not be reclassified by a broad regex.
- Preserve ordered non-text items as omissions without fetching referenced
  bytes, paths, or URLs.
- Emit tool call/result names, IDs, namespaces, arguments, results, and linkage
  only from exact structured fields. A role-only tool row stays unnamed and
  unlinked; a mention is not an invocation.
- For supported side-chat or subagent formats, admit them as separate sessions.
  Emit parent/fork/continuation relations only from explicit IDs. A subagent
  flag, `agent-` prefix, worker prompt, copied content, or UI semantics does not
  prove lineage.
- Keep `lineageCoverage: unknown` unless the supported local schema proves
  exhaustive immediate ancestry.
- Preserve only observed summaries or redacted-reasoning markers. Do not
  reconstruct hidden side-chat parent context, compacted turns, rules, skills,
  MCP catalogs, plans, or cloud continuation.
- Present-but-malformed required evidence fails safely and preserves last-good
  canonical state. An unrecognized installed-looking family is not a complete
  empty scan.

## Performance and correctness proof

Stable indexing necessarily scales with candidate enumeration and metadata
checks. M11 must not add unchanged transcript parsing or per-candidate blob-store
capture to that baseline. Required proof should show:

- unchanged candidates do not call `read` or allocate changed-read capture
  scratch;
- only changed candidates copy/open their own transcript or blob-store inputs;
  bounded discovery staging for a shared catalog remains allowed when required;
- candidate discovery does not parse complete transcripts merely to compute
  freshness;
- main/WAL replacement, append, truncation, checkpoint, disappearance, and
  mutation during copy produce conservative `source-changed` or typed failure;
- no provider main/WAL/SHM bytes, identities, modes, or timestamps are changed;
- cleanup, operation, and lease failures admit no partial document and leave no
  Sessions scratch;
- exact tool/linkage, non-text, injected, timestamp, relation, title/workspace,
  malformed, and unsupported-format cases use sanitized synthetic fixtures;
- complete disappearance, incomplete discovery, reappearance, last-good,
  forget, clear, and capture-scope behavior match Codex through shared engine
  contracts; and
- a third synthetic adapter still passes without provider branches in domain,
  storage, query, export, CLI rendering, or Agent Skills.

## Remaining implementation questions

These are format questions for the M11 plan, not reasons to weaken the boundary:

1. Which exact catalog field supplies globally stable identity for every agent
   JSONL whose filename is not globally unique?
2. What is the complete deterministic blob-root traversal and message ordering
   contract for each supported current store?
3. When JSONL and a blob store describe one agent, which representation is
   transcript authority and which is redundant or supplemental evidence?
4. Where, if anywhere, does current local state serialize side-chat, subagent,
   fork, duplicate, or local/cloud-handoff relations?
5. Which current formats are required for the first supported Cursor matrix, and
   which historical variants have enough sanitized evidence to justify support?
6. What are the supported Windows and Linux storage roots, layouts, and path
   resolution rules, and how will their provider-read-only behavior be proved?

The implementation must stop rather than infer answers from private text,
directory order, timestamps, product labels, or undocumented opaque fields.

## Official sources

All links were accessed on 2026-07-16.

- [Agent overview](https://cursor.com/docs/agent/overview.md)
- [Agent prompting and context](https://cursor.com/docs/agent/prompting.md)
- [Agents Window](https://cursor.com/docs/agent/agents-window.md)
- [Cursor 3.0: new interface](https://cursor.com/changelog/3-0)
- [Side chats help](https://cursor.com/help/ai-features/side-chats.md)
- [Cursor 3.11: side chats and conversation search](https://cursor.com/changelog/side-chat)
- [Conversation search](https://cursor.com/help/ai-features/conversation-search.md)
- [Hooks](https://cursor.com/docs/hooks.md)
- [Subagents](https://cursor.com/docs/subagents.md)
- [Worktrees](https://cursor.com/docs/configuration/worktrees.md)
- [Historical local chat history](https://docs.cursor.com/en/agent/chat/history)
- [Cloud Agents](https://cursor.com/docs/cloud-agent.md)
- [Enterprise privacy and data governance](https://cursor.com/docs/enterprise/privacy-and-data-governance.md)
- [CLI usage](https://cursor.com/docs/cli/using.md)
- [CLI structured output](https://cursor.com/docs/cli/reference/output-format.md)
- [Shared transcripts](https://cursor.com/help/ai-features/shared-transcripts.md)
- [Past chats context](https://docs.cursor.com/context/%40-symbols/%40-past-chats)
- [Plan mode](https://cursor.com/docs/agent/plan-mode.md)
- [Cursor 3.2: multitask, worktrees, and multi-root](https://cursor.com/changelog/04-24-26)
- [Cursor 3.7: cloud subagents and local/cloud handoff](https://cursor.com/changelog/cloud-in-agents-window)
