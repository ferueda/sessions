# Ship the Codex-first durable workflow

- Status: implemented; verification and review fixes passed; awaiting merge
- Milestone: M5
- Date: 2026-07-14
- Plan review: passed with zero findings on 2026-07-14
  (`20260714-181209-1e9112`)
- Implementation verification: 55 test files and 508 tests, compiled and
  offline-packed workflow smokes, and a privacy-safe live Codex index/list/show/
  clear smoke passed on 2026-07-14; `pnpm check` passed. All accepted change-review
  findings were fixed; final-cycle follow-ups passed independent targeted closure
  verification after the workflow run limit.

## Goal

Deliver the first real Sessions user journey: discover one local Codex instance,
durably capture its state database and rollouts without mutating them, then list
and show the resulting canonical evidence entirely from the Sessions-owned
library—even after a complete later scan no longer observes the provider thread. The
slice must prove the provider-neutral model against namespaced tools, linked
calls/results, ordered non-text omissions, lineage, evolving rollout records,
and live source changes before M6 stabilizes query semantics.

Acceptance requires the M5 exit gate in the
[program roadmap](260713-v1-implementation-roadmap.md), the authority and path
rules in the [Codex source survey](../../docs/research/codex-source-survey.md),
and the privacy/source boundaries in the
[architecture memo](../../docs/architecture-memo.md). Implementation stops at
working `index`, `list`, `show`, `forget`, and `data clear`; search, recurrence
analysis, portable export/final machine DTOs, Cursor, and packaged Agent Skills
remain later milestones.

## Locked decisions

### Canonical evidence and schema 4

- `ContentSegment` becomes a discriminated union. `TextContentSegment` has
  `kind: "text"`, exact text, and its existing `sha256-utf8-v1` hash.
  `OmittedContentSegment` has `kind: "omitted"`, `contentClass` limited to
  `image | resource | structured | unknown`, and one canonical `sourceType`.
  A source type is 1–64 UTF-8 bytes of lower-ASCII kebab text matching
  `^[a-z0-9]+(?:-[a-z0-9]+)*$`. Domain admission and storage reconstruction
  preserve the exact token and never trim, case-fold, Unicode-normalize, decode,
  truncate, replace, or repair it. Invalid adapter output is a validation issue
  at the exact `sourceType` path; invalid stored data is repository corruption.
  Both variants retain ordinal, origin, confidence, and string-only source
  metadata.
- A source type is either an adapter-owned literal or comes only from a
  format-declared structural discriminator. The Codex-only discriminator helper
  accepts at most 64 bytes matching `^[a-z0-9]+(?:[_-][a-z0-9]+)*$`, replaces
  `_` with `-`, and revalidates the canonical token. It performs no other
  transformation and must never receive payload text, arbitrary object keys,
  paths, URLs, MIME values, or other content. An unsafe unknown discriminator
  becomes the static `unknown-record`; known omissions and unknown nested items
  use the fixed tokens in the normalization matrix.
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
- Migration 4, `canonical_library_evidence`, adds checked tool columns, durable
  capture/source-observation state, and replaces the
  text-only occurrence table with one strict discriminated occurrence table.
  Its primary key continues to enforce one segment variant per
  session/entry/ordinal. A database check requires either a text `content_id` or
  omitted `content_class`/`source_type`, never both. Existing schema-3 rows copy
  as text; existing tool IDs and generic relations copy unchanged; migrations
  1–3 remain byte-for-byte unchanged. Existing canonical documents and legacy
  run history survive with unknown historical capture/coverage facts. The new
  occurrence check also enforces the canonical source-type byte/grammar contract.
  The new reader therefore has no reindex/rebuild requirement solely because
  schema 4 was applied.

### Durable library and source observation

- M5 replaces the pre-public cache with platform application data. Linux uses an
  absolute `$XDG_DATA_HOME/sessions` or `$HOME/.local/share/sessions`; macOS uses
  `$HOME/Library/Application Support/sessions`; Windows uses absolute
  `%LOCALAPPDATA%\sessions`. An absolute `SESSIONS_DATA_DIR` overrides the whole
  directory. The database is `sessions.sqlite3` with its known WAL/SHM sidecars.
  The exact ephemeral workspace is `<resolved-library-directory>/.scratch`.
  Do not read, migrate, or delete the old `SESSIONS_CACHE_DIR` location or legacy
  Harness cache.
- `IndexPaths` adds that exact scratch path. After acquiring/carrying the
  exclusive index lease, `openWriter` safely removes stale scratch and recreates
  it privately, then exposes a provider-neutral `SourceDiscoveryWorkspace` with
  one `withPrivateDirectory()` callback. `runIndex` passes that capability to
  `discover()` only after writer open. The capability creates a random private
  child after asserting the lease, runs the callback, removes it in `finally`,
  then reasserts the lease. It returns the callback result only when operation,
  cleanup, and final ownership all succeed; otherwise it aggregates applicable
  operation/cleanup/lease errors and never exposes the
  root; Codex sees neither `IndexPaths` nor application-data resolution and owns
  no durable storage. Writer close attempts root removal before releasing the lease,
  but still attempts lease release and database close after cleanup failure and
  aggregates every error. No reader, query, probe, doctor, or paths inspection
  creates or sweeps scratch.

  ```ts
  interface SourceDiscoveryWorkspace {
    withPrivateDirectory<T>(operation: (directory: string) => Promise<T>): Promise<T>;
  }
  ```

  M5 changes the internal port to
  `discover(workspace: SourceDiscoveryWorkspace)`; `probe()` and
  `read(candidate)` remain workspace-free.

- One SQLite database contains durable canonical snapshots/capture state and
  rebuildable FTS/query projections. V1 retains only the latest successful
  normalized snapshot per canonical identity. No TTL, automatic pruning, raw
  provider backup, or immutable snapshot history exists.
- `sessions_source_instances` records latest scan coverage (`complete` or
  `unknown`) and its observation time. Each retained canonical session records
  last observed presence (`present` or `missing`), presence-observation time,
  nullable latest-successful capture time, and nullable last-seen time. Public
  source state is `unknown` whenever the source's latest coverage is unknown;
  otherwise it is the session's last observed presence. Snapshot freshness
  remains an independent `current`/`stale` value.
- Schema-3 sources migrate with coverage `unknown`; existing canonical rows keep
  all content and last-good revisions, record last observed presence `present`,
  and leave historically unknowable timestamps null. Legacy `removed` tracking,
  counts, and run items remain readable historical evidence, but new indexing
  never writes `removed` or deletes a canonical document.
- Indexing uses this state machine:

  | Observation                                            | Effective source state | Canonical snapshot                            |
  | ------------------------------------------------------ | ---------------------- | --------------------------------------------- |
  | Candidate discovered; unchanged                        | `present`              | Preserve; update last-seen                    |
  | Candidate discovered; replacement succeeds             | `present`              | Replace atomically; update capture/last-seen  |
  | Candidate discovered; read fails                       | `present`              | Preserve last-good; mark freshness stale      |
  | Successful complete scan; prior session unseen         | `missing`              | Preserve                                      |
  | Probe/discovery unavailable, unreadable, or incomplete | `unknown`              | Preserve every retained snapshot              |
  | Explicit forget                                        | deleted                | Delete only the selected Sessions-owned copy  |
  | Explicit data clear                                    | deleted                | Delete all known Sessions-owned library files |

- Library timestamps have one owner and one logical observation instant.
  `runIndex`'s application `IndexClock` samples `run.startedAt` once per selected
  source; that value is the run's `observedAt` and is shared by every candidate
  and reconciliation transition in that scan. `startRun` writes coverage
  `unknown` with `coverageObservedAt = observedAt`. Unchanged, replacement, and
  discovered-failure outcomes write presence `present` plus
  `presenceObservedAt = lastSeenAt = observedAt`; replacement alone writes
  `capturedAt = observedAt`, meaning the scan that produced the latest
  successfully persisted normalized snapshot rather than SQLite commit time.
  Missing writes presence `missing` and `presenceObservedAt = observedAt` while
  preserving `lastSeenAt` and `capturedAt`. Successful finalization changes
  coverage to `complete` without changing `coverageObservedAt`; incomplete or
  interrupted runs leave coverage `unknown`. `finishedAt` belongs only to
  run/report history. The SQLite lifecycle clock owns leases, heartbeat/recovery,
  and interrupted-run history only; it never populates library
  observation/capture columns. Historically unknowable migrated timestamps stay
  null.
- Starting a source run makes current scan coverage unknown. Only complete
  discovery followed by successful presence reconciliation records complete
  coverage. `recordUnchanged`, successful replacement, and a discovered read
  failure record present; `recordMissing` updates presence/run evidence only and
  never deletes entries, relations, occurrences, content values, or FTS rows.
  Reappearance restores present; an unchanged fingerprint still skips `read()`.
- Provider-neutral run reports replace newly written `removed` outcomes/counts
  with `missing`; incomplete source status represents unknown coverage rather
  than fabricating per-session absence. Legacy removed history remains readable.
- M7 owns the versioned public canonical projection, deterministic document
  digest, persistence/backfill if needed, and portable export schemas. M5 stores
  the capture/source revision facts needed to construct it but does not invent a
  partially specified digest.
- `sessions forget <canonical-id> [--format human|json]` is idempotent and removes
  the selected tracking identity even when it has only failed or legacy-removed
  state. In one fenced immediate transaction it compensates every deleted
  historical run-item detail by incrementing that run's `omittedItemCount`,
  deletes tracking and its owned canonical snapshot/outgoing relations/entries/
  occurrences/run-item details through foreign keys, then garbage-collects only
  unreferenced content/FTS values. Source instances, source coverage, aggregate
  run counts/status/timestamps, shared content, and incoming relation tuples
  owned by other retained snapshots remain. Therefore forget removes the selected
  snapshot/tracking record, not every mention in other sessions. Internal run
  history must continue to satisfy
  `failed + missing + legacy removed = stored items + omitted items`; omitted
  count is monotonic and includes both cap-omitted and later forget-redacted
  details. Return `forgotten` only when tracking existed and `absent` otherwise.
  A later index can create a new tracking row for the same canonical identity;
  aggregate history stays redacted and preserved incoming relations already
  target that identity. Forget never touches the provider.
- `sessions data clear --yes [--format human|json]` is the only whole-library
  deletion route and removes only the known database/WAL/SHM files plus the exact
  Sessions-owned ephemeral scratch subtree. Do not expose `sessions index clear`.

Writer purposes are `index`, `forget`, and `clear`; every live lease is exclusive.
Acquisition uses this exact matrix:

| Existing lease  | Request index  | Request forget | Request clear |
| --------------- | -------------- | -------------- | ------------- |
| free            | acquire        | acquire        | acquire       |
| live index      | busy           | busy           | busy          |
| live forget     | busy           | busy           | busy          |
| live clear      | busy           | busy           | busy          |
| expired index   | takeover       | takeover       | takeover      |
| expired forget  | takeover       | takeover       | takeover      |
| expired clear   | recovery error | recovery error | takeover      |
| invalid/corrupt | corrupt data   | corrupt data   | corrupt data  |

An allowed takeover atomically increments the generation, replaces owner purpose,
token, and timestamps, interrupts active index runs at the lifecycle-clock time,
and fences the stale owner. A refused acquisition changes neither lease nor runs.
Live conflicts and index/forget attempts against expired clear are lease-layer
`writer-busy`, mapped to sanitized `library-busy` operational failure; corrupt
rows are `corrupt-data`, and stale-owner assert/heartbeat/release is
`writer-lease-lost`. None emits a success report.
Only clear may resume expired clear intent because clear can be between database
close and file unlink; index and forget are wholly transactional and have no
post-close mutation. Forget creates no index run, renews its lease while active,
and uses the same stop-heartbeat/release/close error aggregation as indexing. A
crash before its deletion commit rolls back; after commit a retry following lease
expiry returns `absent`. A stale forget owner cannot heartbeat, mutate, or release.

Ready-library health renders a live forget lease as `forget-live`, alongside
`free`, `index-live`, `clear-live`, `expired`, and `invalid`. An active index run
is healthy only with `index-live`; live forget/clear or expired with an active run
is unhealthy. Tokens and lease timestamps never enter public diagnostics.

### Lease-safe schema cutover

The migration-requiring requested purpose (`index | forget`) is known before
migration. A current schema-4 database uses the matrix above for every writer
purpose before any application write. An existing schema-3 database routes index
and forget through the coordinator below; clear never enters this coordinator or
applies migration 4.

1. A dedicated coordinator opens `BEGIN IMMEDIATE`, re-reads/validates exact
   schema-3 history and its `free | index | clear` lease state, and arbitrates
   the requested final purpose (`index | forget`). Live index/clear and expired
   clear roll back with `writer-busy`; malformed or impossible state rolls back
   with `corrupt-data`. Refusal changes no schema, history, lease, active run, or
   canonical data.
2. For an allowed free/expired state, retain the old generation in memory, execute
   static checksummed migration 4 (including its lease-table rebuild/copy), then
   update the new row to generation + 1, the actual requested purpose, new token,
   and fresh lifecycle-clock timestamps. Interrupt active runs at that same time,
   insert migration history, assert the final identity, and commit as one atomic
   ownership/schema transition. Because `forget` is written only after the new
   check exists, no provisional schema-3 purpose is needed.
3. Re-sample the lifecycle clock after migration SQL and roll back if it moved
   behind the prior lease timestamp. Start heartbeat immediately after commit.
   Later setup failure releases only the carried schema-4 identity; the old
   generation/token remains fenced.

Migration application/history insertion and lease arbitration expose reusable
transaction bodies so the coordinator never nests `BEGIN IMMEDIATE`. Generic
schema-3-to-4 migration outside this path is impossible. History is re-read under
the transaction to close inspect/open races; if another process already reached
schema 4, acquisition restarts against the normal schema-4 matrix. Fresh and
pre-schema-3 databases retain ordered migration behavior, then use this cutover
whenever schema 3 is the locked current version.

`sessions data clear` never invokes the migration coordinator and never applies
migration 4. After path-safety inspection, it opens the existing database, begins
`IMMEDIATE`, re-reads migration history under the lock, and dispatches by exact
schema:

- Schema 3 admits only `free | index | clear`. Free acquires clear; any live
  index/clear returns `writer-busy`; expired index/clear is taken over; a
  `forget` or malformed row is `corrupt-data`.
- Schema 4 admits `free | index | forget | clear`. Free acquires clear; any live
  purpose returns `writer-busy`; any expired purpose is taken over; malformed
  state is `corrupt-data`.

In the same allowed transaction, clear samples the lifecycle clock, increments
generation, writes purpose `clear` with a new token/fresh timestamps, interrupts
active runs at that timestamp, asserts the carried identity, and commits. It
writes no schema or migration history. Every refusal rolls back without mutation.
Older pre-lease schemas retain their separately classified legacy policy; valid
schema 3 cannot enter that direct-unlink branch. Newer, unrecognized, corrupt, or
unsafe state is refused.

After clear acquisition, heartbeat remains active while the service validates
database state and scratch without mutation, then recursively removes only the
exact scratch subtree without following symlinks. Beginning that removal is the
destructive-intent boundary when scratch exists; when absent, the boundary is
the final-renewal/checkpoint sequence immediately before close/unlink. Any later
failure leaves the clear lease so only clear can resume after expiry. It then
stops scheduled heartbeat, performs one
final renewal, checkpoints/truncates, asserts the carried lease, closes without
releasing, snapshots the post-close database/WAL/SHM identities, verifies the
lease through an immutable sidecar-free open, immediately re-stats the captured
identities, then unlinks only SHM, WAL, and database. A safe failure before
scratch removal begins releases when possible. No database/sidecar and no
scratch returns `absent`; an orphan scratch root without its lease-bearing
database is `recovery-required`, not removed without coordination. Unsafe
scratch or partial database state is refused.

Fixtures cover live and expired schema-3 index/clear, schema-4 expired-forget
clear takeover, mutation-free refusal, generation takeover, active-run
interruption, migration/history/commit rollback, post-commit setup cleanup,
already-schema-4 races, and stale-owner assert/write/heartbeat/release fencing.
Schema-3 clear proves that schema/history remain byte-for-byte at version 3
before owned unlink. Scratch fixtures cover stale-root takeover, live-lease no-
touch, unsafe root/symlink refusal, lease loss inside a workspace callback,
operation-plus-cleanup aggregation, writer-close release/close attempts after
cleanup failure, clear failures on both sides of destructive intent, post-close
file replacement, orphan-root refusal, exact-root-only recursion, and exact
`scratchRemoved` reporting.

### Codex source authority and identity

- V1 supports one global/default Codex instance per invocation. Its opaque
  instance ID is `local-sha256-v1:<64 lowercase hex>`, computed from a
  versioned canonical tuple of the resolved Codex home and SQLite home. After all
  precedence, absolute normalization, and existing-root `realpath` resolution,
  serialize exactly this JavaScript array with `JSON.stringify` and no replacer
  or spacing:

  ```json
  [
    "sessions-codex-source-instance-v1",
    ["codex-home", "<resolved-codex-home>"],
    ["sqlite-home", "<resolved-sqlite-home>"]
  ]
  ```

  Hash the serialized string's UTF-8 bytes with SHA-256 and append the lowercase
  hexadecimal digest. Do not Unicode-normalize or case-fold either platform path.
  The POSIX golden preimage
  `["sessions-codex-source-instance-v1",["codex-home","/home/alice/.codex"],["sqlite-home","/home/alice/.codex"]]`
  yields
  `local-sha256-v1:9a91043ef784ba9f431f57bd649a1991bbefc00d6fba9d266ab5b44268aa7d4e`.
  The digest prevents private paths entering canonical IDs while keeping
  different roots isolated.

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
- SQLite never receives a provider-owned state path. The adapter reads provider
  database/WAL bytes only through read-only filesystem handles, builds the
  verified process-private snapshot below, and opens SQLite only on that private
  copy. Direct `mode=ro`/`readOnly` provider opens are forbidden because WAL
  readers may mutate provider SHM read marks. Direct `immutable=1` is also
  forbidden because it does not supply an authoritative active-WAL view.

#### Mutation-free state snapshot

`src/adapters/codex/state-snapshot.ts` implements one state capture per complete
`discover()` generation. Persistent authority is the required regular
`state_5.sqlite` plus
an optional regular `-wal` sibling; symlinks/special files are refused. Provider
SHM is derived coordination state: the adapter never opens, copies, or uses it
for capture stability, and its absence does not block a WAL snapshot. The module
makes at most three attempts:

1. Open the fixed provider file set with read-only filesystem handles. Capture
   each database/WAL path/handle's bigint `dev`, `ino`, `mode`, `size`,
   `mtimeNs`, `ctimeNs`, and `birthtimeNs` tuple and hash its exact bytes with
   SHA-256.
2. Use the random private directory supplied by `SourceDiscoveryWorkspace` after
   the owned index writer acquires its lease. Its hidden root is the exact
   `<resolved-library-directory>/.scratch` path. The root/attempt directory and
   files are forced to
   `0700`/`0600` on POSIX; Windows uses the current user's application-data ACL.
   Rewind and stream-copy from the already validated handles—not reopened
   provider paths—to fixed private names while hashing the copied bytes. SHM is
   derived coordination state and is never copied.
3. Open fresh read-only handles and re-hash the provider database/WAL set,
   re-stat the original handles and paths, and re-check its exact
   presence/identity. The attempt
   succeeds only when provider pre/post stat tuples are identical and each
   pre/copy/post database/WAL hash is identical. Any WAL
   appearance/disappearance or persistent-file replacement/byte change disposes
   that attempt before retry.
4. Open only the private database with `mode=ro`/`readOnly`, private cache,
   `query_only=ON`, and a short deferred transaction. Its writable private
   directory lets SQLite rebuild a private SHM and read committed WAL frames,
   including when provider SHM was absent. In that single transaction,
   feature-detect and materialize every admitted thread/edge value into one
   adapter-private immutable generation map. Close SQLite and dispose the entire
   attempt directory in `finally` before yielding any candidate.

These whole-file hashes are transient snapshot validation, never candidate
fingerprints, public diagnostics, or retained content. The private copy is an
ephemeral execution artifact, not the durable raw-provider backup rejected by
the product design. Names contain no source IDs or content. Normal adapter
completion removes each attempt; a successful writer close removes the empty
root before releasing its lease. A process/host crash or surfaced cleanup failure
can leave raw state bytes beneath this
permission-restricted Sessions-owned subtree until the next index writer safely
sweeps it after acquiring/taking over the exclusive lease, or explicit data
clear removes it. M5 adds no retained snapshot, restore path, or provider rollout
copy.

Discovery completes the immutable generation map before yielding. Candidate
descriptors carry only the canonical fingerprints already defined by the source
port; `read(candidate)` requires the adapter's current frozen row/edge values to
match those descriptors and never reopens state SQLite. A later provider state
change is observed by the next discovery generation. Read uses the frozen
rollout selection and metadata, then verifies only the live rollout descriptor
before and after streaming. This avoids one full database copy per candidate and
implements the adapter contract's allowed equivalent stable snapshot.

Three changing attempts throw a sanitized `source-changed` failure. During
discovery, the engine reports `discovery-failed`, retains zero partial candidates,
leaves coverage unknown, and performs no presence reconciliation. A stale or
mismatched candidate generation is `source-changed` during candidate read and
its last-good snapshot remains. Stable provider permission failure is
`unreadable`. Scratch staging or cleanup I/O failure is a sanitized discovery
operation failure before candidates exist; it is never labeled provider
corruption. A stable private copy with an incompatible schema is
`unsupported-format`; invalid database/WAL structure is `malformed`. No failure
exposes paths, hashes, SQLite text, or source content.

Implement this module and its feasibility gate before the state-schema gateway.
An idle live-WAL fixture with an open provider writer must return its latest
uncheckpointed committed row while a recursive before/after proof keeps provider
database/WAL/SHM bytes, identity tuples, modes, and mtime/ctime values unchanged.
Capture stability itself watches only persistent database/WAL authority, so
unrelated provider read-mark churn in SHM cannot cause false retries.
Deterministic copy hooks mutate/replace/add/remove database/WAL and prove retry
then sanitized exhaustion. Other fixtures cover closed state, WAL with absent
SHM, malformed or mismatched WAL, permissions/staging failure, cleanup on every
error, process-private sidecar creation only, and a negative control showing that
`immutable=1` misses an uncheckpointed committed row. A concurrent
writer/checkpointer/WAL-reset stress fixture writes a cross-table generation
invariant; every accepted capture must equal one complete committed generation,
never mixed rows or corrupt state. Raw hot-copy stability is an optimistic
verified-window protocol, not an SQLite-guaranteed backup. If this stress proof
cannot pass on every supported CI platform—or ever accepts an inconsistent
generation—M5 stops/fails closed for active WAL with unknown coverage and retry/
close-Codex guidance. It never falls back to opening provider SQLite directly.

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

Before parsing, `read()` requires the adapter's current immutable generation to
contain the same native ID and exact frozen row/edge/rollout descriptors as the
candidate; a missing/replaced generation or mismatch is `source-changed`. It
never reopens state SQLite. It reselects/stats the frozen rollout path, opens the
verified file handle, stats that handle, streams it, then stats/closes the handle
and reselects the path/representation. Any live rollout/representation difference
takes precedence as `source-changed`; no partial document escapes. Provider
row/edge changes after discovery are observed by the next discovery generation
and do not rewrite the current frozen read. A stable rollout permission failure
is `unreadable`; invalid UTF-8/JSON/Zstandard or malformed recognized records are
`malformed`; a stable record beyond the supported bound is `unsupported-format`.

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

The checked-in M5 support document and parser implement this closed matrix,
pinned to the upstream revision cited by the source survey. Every JSONL record
must be a plain object with a non-empty string `type` and a plain-object
`payload`. A non-empty string means `length > 0` after JSON
decoding; it is never trimmed or normalized. Optional means absent or `null`
unless a row says otherwise. For a supported variant, every consumed field and
its type appears below; unlisted keys are ignored and never copied or validated.
A wrong shape for a listed field makes the candidate `malformed`.

The parser has three exhaustive treatments:

1. **Supported** discriminators validate and project only the fields below.
2. **Deferred** discriminators inspect no payload fields. They emit one `unknown`
   entry with one omitted `unknown` segment whose source type is that listed
   discriminator after the exact snake-to-kebab conversion. This records
   existence without interpreting or copying content.
3. **Known skip** discriminators inspect no fields beyond the containing
   plain-object payload and its `type`. They emit nothing.

Any other valid discriminator receives the deferred treatment through the safe
discriminator helper or `unknown-record` fallback. Every deferred, unknown, and
known-skip record clears adjacent-message eligibility.

A present top-level timestamp must be RFC3339 and is normalized to canonical UTC
milliseconds. Every entry emitted from that record receives that timestamp;
without one, its timestamp is absent. Every emitted entry receives the next
canonical ordinal and a private logical rollout locator plus decimal
source-record ordinal. Every M5 Codex segment has `sourceMetadata: {}`. No
unrecognized object is serialized.

| Evidence family                         | Actor     | Origin      | Confidence |
| --------------------------------------- | --------- | ----------- | ---------- |
| user message/image                      | `human`   | `human`     | `high`     |
| assistant/reasoning/tool call           | `model`   | `model`     | `high`     |
| developer/base/legacy/compacted context | `system`  | `injected`  | `high`     |
| system/lifecycle/diagnostic/compaction  | `system`  | `system`    | `high`     |
| tool result                             | `tool`    | `tool`      | `high`     |
| inter-agent message                     | `model`   | `delegated` | `high`     |
| deferred or unknown record              | `unknown` | `unknown`   | `unknown`  |

#### Outer records

| Outer `type`                         | Consumed fields                                                                                                                       | M5 treatment                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `session_meta`                       | non-empty `id`; optional non-empty `session_id`, `parent_thread_id`, `forked_from_id`; optional `base_instructions: { text: string }` | metadata/lineage; base text becomes one `injected-context` entry                      |
| `turn_context`                       | optional non-empty `turn_id`; optional string `user_instructions` and `developer_instructions`                                        | turn metadata; instruction entries in user-then-developer field order                 |
| `response_item`                      | non-empty payload `type`                                                                                                              | authoritative response dispatch                                                       |
| `event_msg`                          | non-empty payload `type`                                                                                                              | event dispatch                                                                        |
| `inter_agent_communication`          | string `author`, `recipient`, and `content`; optional string `encrypted_content`                                                      | one `inter-agent-message`; text then `unknown`/`encrypted-agent-content` when present |
| `compacted`                          | string `message`                                                                                                                      | `compaction` marker followed by one `injected-context` containing the message         |
| `inter_agent_communication_metadata` | no fields                                                                                                                             | known skip; `trigger_turn` is not inspected                                           |
| `world_state`                        | no fields                                                                                                                             | known skip; never inspect or retain snapshot content                                  |
| any other valid outer type           | no fields                                                                                                                             | deferred/unknown treatment with the outer discriminator                               |

For `session_meta`, `session_id` may be absent for a legacy record; when present
it must equal `id`. At least one record whose `id` equals the discovered native
thread is required. A record for another ID is inherited replay context: it emits
no relation or injected entry and cannot replace current metadata. On a current
record, a state edge is authoritative and produces one `parent` relation; either
metadata ID must equal that target when present. Without a state edge,
`parent_thread_id` produces one `parent` relation; otherwise `forked_from_id`
produces one `fork` relation. When both metadata IDs are present, they must be
equal and the parent rule wins. Any mismatch is malformed. Dynamic/additional
tool catalogs and every unlisted metadata field are ignored in M5. No replay
origin is inferred from repeated metadata.

Each current metadata occurrence with `base_instructions.text` emits its own
entry. Identical relations across current records collapse to one relation;
conflicting current records are malformed.

For `turn_context`, legacy instruction strings become separate
`injected-context` entries in the fixed order `user_instructions` then
`developer_instructions`. Both use the developer/base instruction evidence
family. They are retained on every occurrence and never become human intent.

#### Authoritative `response_item` payloads

| Payload `type`                      | Consumed fields                                                                                                              | Canonical projection                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `message`                           | `role` is `user`, `assistant`, `developer`, or `system`; array `content`; optional `phase` is `commentary` or `final_answer` | one `message` with the exact role mapping below                               |
| `agent_message`                     | string `author` and `recipient`; array `content`                                                                             | one `inter-agent-message` with delegated segments                             |
| `reasoning`                         | array `summary`; optional array `content`; optional string `encrypted_content`                                               | one `reasoning-summary` with ordered visible and omitted segments             |
| `function_call`                     | non-empty `call_id` and `name`; string `arguments`; optional non-empty `namespace`                                           | `tool-call` with exact ID/name/namespace and one exact argument segment       |
| `function_call_output`              | non-empty `call_id`; string or supported-item-array `output`                                                                 | `tool-result` with ordered output segments; no name/namespace                 |
| `custom_tool_call`                  | non-empty `call_id` and `name`; string `input`; optional non-empty `namespace`                                               | `tool-call` with exact ID/name/namespace and one exact input segment          |
| `custom_tool_call_output`           | non-empty `call_id`; string or supported-item-array `output`                                                                 | `tool-result`; optional source `name` is ignored                              |
| `compaction` / `compaction_summary` | string `encrypted_content`                                                                                                   | `compaction` marker with one omitted `unknown`/`encrypted-compaction` segment |
| `context_compaction`                | optional string `encrypted_content`                                                                                          | `compaction` marker, then the encrypted omission when present                 |
| `compaction_trigger`                | no fields                                                                                                                    | known skip                                                                    |

Message role mapping is exact: `user` -> human/human, `assistant` ->
model/model, `developer` -> system/injected, and `system` -> system/system. Any
other role makes this supported payload malformed. `phase` is validated but does
not alter the canonical projection.

Nested item support is also closed:

| Parent field                    | Supported item `type` and fields                                                              | Ordered segment                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `message.content`               | `input_text { text: string }`, `output_text { text: string }`                                 | exact text                                                         |
| `message.content`               | `input_image { image_url: string }` with optional detail `auto`, `low`, `high`, or `original` | omitted `image`/`input-image`; URL is discarded                    |
| `agent_message.content`         | `input_text { text: string }`                                                                 | exact delegated text                                               |
| `agent_message.content`         | `encrypted_content { encrypted_content: string }`                                             | omitted `unknown`/`encrypted-agent-content`                        |
| `reasoning.summary`             | `summary_text { text: string }`                                                               | exact model reasoning-summary text                                 |
| `reasoning.content`             | `reasoning_text { text: string }` or `text { text: string }`                                  | omitted `unknown`/`reasoning-content`; hidden text is never copied |
| function/custom result `output` | `input_text { text: string }`                                                                 | exact tool text                                                    |
| function/custom result `output` | `input_image { image_url: string }` with optional detail `auto`, `low`, `high`, or `original` | omitted `image`/`input-image`; URL is discarded                    |
| function/custom result `output` | `encrypted_content { encrypted_content: string }`                                             | omitted `unknown`/`encrypted-tool-content`                         |

Nested items must be plain objects with a non-empty string `type`. A listed item
with a wrong listed field is malformed. An unlisted item type is not inspected:
message, agent-message, and reasoning arrays emit
`unknown`/`unknown-content-item`; result arrays emit
`structured`/`unknown-content-item`. Array order is canonical segment order.
Unknown nested segments retain their parent evidence family's origin and
confidence; only a whole deferred/unknown record uses unknown/unknown provenance.
For reasoning, summary segments come first, followed by one omission per
`content` item and then the encrypted omission. A string result or call
argument/input, including the empty string, remains one exact text segment. An
empty result array produces a `tool-result` entry with zero segments.

The exact deferred response discriminators are `additional_tools`,
`local_shell_call`, `tool_search_call`, `tool_search_output`,
`web_search_call`, and `image_generation_call`. Each uses the deferred treatment
and therefore produces, for example, `unknown`/`local-shell-call` rather than a
partially interpreted call. Every other valid response discriminator uses the
generic unknown treatment.

#### `event_msg` payloads

| Payload `type`                         | Consumed fields                                                                                                         | Canonical projection                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `user_message`                         | string `message`; optional `images` as null or string array; `local_images` absent or string array, with null malformed | fallback human message: text, then one `input-image` per image, then one `local-image` per local image |
| `agent_message`                        | string `message`                                                                                                        | fallback model `message` with exact text                                                               |
| `agent_reasoning`                      | string `text`                                                                                                           | fallback model `reasoning-summary`                                                                     |
| `task_started` / `turn_started`        | non-empty `turn_id`                                                                                                     | `turn-started` marker and exact-ID lookup key                                                          |
| `task_complete` / `turn_complete`      | non-empty `turn_id`; optional `error` as null or `{ message: string }`                                                  | `turn-completed` marker; then optional diagnostic; ignore every unlisted timing/message field          |
| `turn_aborted`                         | optional null/non-empty `turn_id`; `reason` in `interrupted`, `replaced`, `review_ended`, `budget_limited`              | `turn-aborted` marker related only by exact turn ID; no success/failure inference                      |
| `thread_rolled_back`                   | `num_turns` as an integer from 0 through 4,294,967,295                                                                  | `rollback` marker; validate but do not retain the count                                                |
| `context_compacted`                    | no consumed fields                                                                                                      | fallback `compaction` marker                                                                           |
| `error`, `warning`, `guardian_warning` | string `message`                                                                                                        | one `diagnostic` with exact text                                                                       |
| `stream_error`                         | string `message`; optional string `additional_details`                                                                  | one `diagnostic` with message, then details when present                                               |
| `deprecation_notice`                   | string `summary`; optional string `details`                                                                             | one `diagnostic` with summary, then details when present                                               |

The exact deferred event discriminators are:

`mcp_tool_call_begin`, `mcp_tool_call_end`, `web_search_begin`,
`web_search_end`, `image_generation_begin`, `image_generation_end`,
`exec_command_begin`, `exec_command_end`, `view_image_tool_call`,
`dynamic_tool_call_request`, `dynamic_tool_call_response`,
`patch_apply_begin`, `patch_apply_end`, `entered_review_mode`,
`exited_review_mode`, `item_completed`, `collab_agent_spawn_begin`,
`collab_agent_spawn_end`, `collab_agent_interaction_begin`,
`collab_agent_interaction_end`, `collab_waiting_begin`,
`collab_waiting_end`, `collab_close_begin`, `collab_close_end`,
`collab_resume_begin`, `collab_resume_end`, and `sub_agent_activity`.

The whole deferred payload becomes one unknown omission. Nested fields are never
inspected, linked, or mapped. Thus `dynamic_tool_call_response` always produces
`unknown`/`dynamic-tool-call-response` in M5; image or text inside it has no
separate M5 mapping.

The exact known-skip event discriminators are:

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
`agent_message_content_delta`, `plan_delta`, `reasoning_content_delta`, and
`reasoning_raw_content_delta`.

A known skip emits no entry; its other fields are not validated. Every other
valid event discriminator uses the generic unknown treatment.

#### Precedence, linkage, and duplicate rules

1. Function/custom calls and results reconcile across the complete rollout by
   exact call ID, including result-before-call. One ID may identify at most one
   supported call and one supported result; any duplicate is malformed. A result
   relation is added only when the single matching call exists. Unmatched
   evidence remains canonical and unlinked.
2. No deferred event backfills, links to, or deduplicates a supported response
   call/result, even when an ignored payload field happens to carry the same ID.
3. Collapse messages only when physically adjacent, cross-family
   response/event representations have the same actor and identical complete
   ordered segment kind, exact text or omission class/source type, origin, and
   confidence, plus the same normalized timestamp presence/value. Keep the
   response item and its locator. Preserve same-family, non-adjacent, or
   partially different repeats.
4. Preserve every compaction representation; M5 performs no compaction
   deduplication. Replacement history is ignored, never normalized as fresh
   canonical entries.
5. Tool catalogs, user requests, model claims, and plain-text names never become
   calls. Task completion never means success. State spawn edges own lineage;
   equal text never creates replay, delegation, fork, or parent evidence.

### M5 command surface

- `sessions index [--source codex] [--format human|json]` selects all registered
  sources when omitted. Unknown/unregistered sources are usage failures before a
  writer opens. A complete report exits `0`; a fully rendered incomplete report
  exits `1`. Reports use `missing`, never a newly produced `removed` outcome, and
  expose source coverage without deleting retained snapshots.
- `sessions forget <canonical-id> [--format human|json]` returns `forgotten` or
  `absent`; both exit `0`. Identity usage errors fail before opening a writer.
- `sessions data clear --yes [--format human|json]` calls only the adapted
  Sessions-owned all-data maintenance port. Missing `--yes` is usage failure;
  absent and cleared outcomes exit `0`.
- `sessions list [--limit N]` is human-only until M7. Default `N` is 50 and the
  maximum is 200. Order is missing activity timestamps last, then
  `coalesce(updatedAt, createdAt)` descending, then the raw identity tuple
  `source.kind`, `source.instanceId`, and `nativeId`, each ascending with SQLite
  `BINARY` collation. This intentionally differs from printable-ID lexical order
  because printable IDs percent-encode opaque components. The repository executes
  the equivalent `CASE`/`COALESCE`/raw-tuple `ORDER BY ... LIMIT ?`; the service
  requests `N + 1`, removes only the sentinel, reports truncation, and never
  re-sorts. Each row shows snapshot freshness, effective source state, and capture
  time when known. On an uninitialized fresh library, list returns the application
  result `{ sessions: [], truncated: false }`, renders exactly
  `No sessions found.` plus a newline, and exits `0` without creating state or
  probing providers. The service inspects before opening a reader: only ready
  opens a snapshot; other initialized/non-ready states remain operational errors.
- `sessions show <canonical-id> [--entry N --context N]` is human-only until M7.
  Without `--entry`, show the first 50 entries and report the displayed range and
  total. With an entry, default context is 3 on each side; maximum context is 100. `--context` without `--entry` is invalid usage. Missing IDs/entry ordinals
  are operational failures. Each text segment is capped at 8 KiB of UTF-8 output
  and the entry body at 256 KiB, with explicit truncation; omitted segments render
  only class and the admitted canonical source-type token. Show includes the same
  capture/source state before transcript entries. An uninitialized library is
  treated as the requested identity being absent and follows the same sanitized
  not-found operational failure as a missing identity; it still creates no state.
- List/show receive only library lifecycle/paths and never a source adapter. They
  omit `sourceLocator` and `sourceMetadata`, escape terminal controls in every
  untrusted scalar, and remain available when provider files change or vanish.
  Local workspace is usable for in-library list filtering later but is not shown
  in M5 human output. Final JSON/JSONL DTOs, document digest, portable export,
  `--full`, pagination, query filters, and corpus-tuned bounds remain M6–M7 work.

### M5 structured reports

M7's DTO deferral applies to transcript/query/export records only. M5 publishes
these exact operational JSON contracts; numeric counts are non-negative safe
integers, timestamps are canonical UTC milliseconds, `SessionRef.canonicalId` is
the canonical printable ID, and arrays retain the deterministic orders stated
below. Index uses schema 2 because the internal pre-public schema-1 meaning is
superseded by missing/coverage semantics; forget and data clear are first-public
schema 1:

```ts
type SourceRef = { kind: string; instanceId: string };
type SessionRef = {
  canonicalId: string;
  source: SourceRef;
  nativeId: string;
};

type IndexCountsV2 = {
  discovered: number;
  unchanged: number;
  updated: number;
  failed: number;
  missing: number;
  stale: number;
};

type IndexItemV2 =
  | { identity: SessionRef; outcome: "missing" }
  | {
      identity: SessionRef;
      outcome: "failed";
      failure:
        | "unavailable"
        | "unreadable"
        | "malformed"
        | "source-changed"
        | "unsupported-format"
        | "repository-write";
    };

type SourceIndexReportV2 = {
  schemaVersion: 2;
  source: SourceRef;
  status: "completed" | "incomplete";
  coverage: { status: "complete" | "unknown"; observedAt: string };
  startedAt: string;
  finishedAt: string;
  counts: IndexCountsV2;
  items: readonly IndexItemV2[];
  omittedItemCount: number;
  failure?:
    | "source-unavailable"
    | "source-unreadable"
    | "probe-failed"
    | "discovery-failed"
    | "interrupted"
    | "repository-write";
};

type IndexReportV2 = {
  schemaVersion: 2;
  command: "index";
  startedAt: string;
  finishedAt: string;
  counts: IndexCountsV2;
  sources: readonly SourceIndexReportV2[];
  incompleteSources: number;
  omittedItemCount: number;
};

type ForgetReportV1 = {
  schemaVersion: 1;
  command: "forget";
  identity: SessionRef;
  outcome: "forgotten" | "absent";
};

type DataClearReportV1 = {
  schemaVersion: 1;
  command: "data-clear";
  outcome: "cleared" | "absent";
  scratchRemoved: boolean;
  databaseRemoved: boolean;
  walRemoved: boolean;
  shmRemoved: boolean;
};
```

`DataClearReportV1.outcome` is `absent` only when all four removal booleans are
false. `scratchRemoved` reports the exact `.scratch` subtree; the three other
booleans retain their named-file meaning. Because orphan scratch without its
lease-bearing database is recovery-required, a successful scratch-only clear is
not produced.

For a source report, completed means `coverage.status = complete` and no
`failure`; incomplete means unknown coverage plus the required failure. Coverage
observation time equals source `startedAt`. `discovered = unchanged + updated +
failed`, and `stale <= failed`; missing is reconciliation, not discovery. Items
contain only failed/missing details and satisfy `failed + missing = items.length +
omittedItemCount` when the report is returned. Schema-4 `removed` counts/items are
legacy persisted history only: never rename them to missing and never emit them
in a new M5 index report. Top counts/omissions are safe sums; sources are ordered
by raw source kind/instance ID and items by repository outcome order.

Paths schema 2 is exactly:

```ts
type PathsReportV2 = {
  schemaVersion: 2;
  command: "paths";
  library: {
    directory: string;
    scratch: string;
    database: string;
    wal: string;
    shm: string;
    initialized: boolean;
    state:
      | "uninitialized"
      | "ready"
      | "migration-required"
      | "newer-schema"
      | "incompatible"
      | "recovery-required"
      | "unsafe";
    schemaVersion: number | null;
    supportedSchemaVersion: number;
  };
  sources: readonly {
    source: SourceRef;
    probe:
      | {
          status: "ready" | "unavailable" | "unreadable";
          locations: readonly { role: string; uri: string }[];
        }
      | {
          status: "failed";
          failure: "invalid-probe" | "probe-error";
          locations: readonly [];
        };
  }[];
};
```

Source entries sort by raw source tuple, and M5 contains one Codex entry. An
admitted Codex probe has exactly `codex-home` then `sqlite-home` canonical `file:`
URL locations; both are emitted even when equal, and `recordId` is omitted. Valid
unavailable/unreadable, malformed, and thrown probes remain a successful paths
report: the latter two use the exact failed union with no guessed location or raw
error. Failure before a stable `SourceRef` exists, or library inspection failure,
produces no partial JSON and exits operationally.

Doctor schema 2 retains the exact top-level/check shape from schema 1 and changes
the order to `node-runtime`, `sqlite-fts5`, `library-state`, `source-codex`.
`library-state` replaces `index-state`; its common string details are `state`,
`initialized`, `schemaVersion`, and `supportedSchemaVersion`, plus the existing
state-specific `reason` and/or `target`. Ready state adds exactly
`canonicalIntegrity`, `foreignKeys`, `ftsStructure`, `ftsContent`,
`ftsSecureDelete`, `ftsRemediation`, `runRecords`, `writerLease`, `activeRuns`, and
`interruptedRuns`. `canonicalIntegrity` validates the non-FTS canonical/state
tables and reconstructable documents independently of derived FTS. It,
foreign-key, FTS structure/content, and run-record values are `ok | failed`; FTS
secure-delete is `enabled | missing | unsupported`; `ftsRemediation` is
`not-needed | rebuild-required`; writer lease is
`free | index-live | forget-live | clear-live | expired | invalid`; counts are
decimal strings. FTS remediation is rebuild-required for structure/content or
required-configuration failure and never recommends canonical deletion. The
separate FTS fields distinguish rebuildable projection health from
database/foreign-key/run integrity.

An admitted `source-codex` probe has exactly `probeStatus` with value
`ready | unavailable | unreadable`; ready is healthy and the other two fail.
Malformed or thrown probe data fails with exactly
`{ probeStatus: "failed", failure: "invalid-probe" | "probe-error" }`. Doctor does
not duplicate roots owned by paths and emits no raw errors. Summaries and labels
remain human-facing. Schema-2 doctor keeps aggregating after failures; every check
uses the standard `{ id, label, ok, summary, details }` shape.

## Changes

1. `src/domain/session.ts:ContentSegment` and `SessionEntry`, a focused
   `src/domain/source-type.ts`,
   `src/domain/session-validation.ts:validateSessionDocument`, and
   `src/application/validate-session.ts` — implement the canonical evidence
   union and tool/link invariants above. Preserve contiguous mixed segment
   ordinals and deep immutable snapshots. Update `test/fixtures/session.ts`, the
   synthetic source, and source/index contract helpers to construct explicit
   text or omitted variants. Keep a legacy non-tool `toolCallId` fixture and add
   separate canonical `tool-call`/`tool-result` evidence fixtures. Lock the exact
   source-type predicate and validation path with 1/64-byte valid tokens plus
   empty, 65-byte, uppercase, Unicode, whitespace, control, slash/backslash, URL,
   data-URL, underscore, and leading/trailing/double-hyphen failures.

2. `src/infrastructure/sqlite/migrations/0004-canonical-library-evidence.ts`
   and `src/infrastructure/sqlite/migrations.ts` — add schema 4 without editing
   prior migrations. Rebuild occurrences transactionally and recreate its content
   index as a partial index for non-null `content_id`. Add source coverage state,
   canonical capture/last-seen/presence state, `missing` run evidence, and the
   `forget` writer-lease purpose while preserving legacy `removed` history,
   leases, FTS, last-good revisions, and canonical documents. Schema-3 sources
   migrate to unknown coverage; canonical rows retain content with null unknown
   timestamps. Add a schema-3-to-4 test proving exact document/text/FTS and writer
   history preservation, SQL impossible-state checks, clean foreign keys,
   rollback, and legacy removed readability. Seed currently valid schema-3 rows
   containing a non-tool call ID and a tool-result relation to a non-call entry;
   prove both survive migration and reconstruction unchanged. The omitted
   branch's SQL check enforces the same 1–64-byte ASCII kebab grammar. Keep
   run-item `ON DELETE CASCADE`; define `omitted_item_count` as details omitted
   by either the 100-item cap or later scoped forget, and make run-record
   integrity use the locked failed/missing/legacy-removed equation. Rebuild the
   lease table constraint to admit `forget` while preserving exact free/index/
   clear rows from schema 3. Add the index/forget-only lease-aware migration
   coordinator and prove it owns/carries the requested lease before exposing
   schema 4; do not call the ordinary migrate-before-acquire path for initialized
   schema 3. Data clear uses the separate non-migrating schema-version dispatcher
   above.

3. `src/infrastructure/sqlite/sqlite-session-document.ts`,
   `sqlite-session-state.ts`, `sqlite-session-index.ts`, and focused repository
   tests/contracts — persist tool identity and capture/presence facts; intern only
   text; write omitted rows with no content ID; `LEFT JOIN` and discriminate on
   reconstruction; reject corrupt XOR/tool/state columns before domain admission.
   Replace reconciliation deletion with `recordMissing`, which changes only
   observation/run state. Keep an explicit deletion primitive for forget. Prove
   text–omitted–text round trip, no omitted FTS/hash/content-value row,
   collision/dedup behavior, atomic replacement, non-destructive missing,
   explicit forget garbage collection and run-detail compensation, reappearance,
   and linked result identity. Reconstruction independently checks source type
   before domain admission and returns sanitized `corrupt-data`; it never invokes
   the adapter normalizer or repairs persisted values.

4. `src/adapters/codex/config.ts`, `paths.ts`, and `source-instance.ts` — implement
   the captured-environment path algorithm, bounded TOML read, root/legacy
   precedence, opaque instance digest, rollout logical-name selection, and
   realpath containment. Unit fixtures cover missing/empty/relative/literal-tilde
   environment values, config tables/comments/relative/`~/`/wrong-type values,
   config-over-environment precedence, explicit missing/corrupt roots, root over
   legacy, filename/ID mismatch, archive/session roots, traversal, symlink
   escape, special files, and plain-over-Zstandard selection. Source-instance
   tests lock the exact golden preimage/digest above, repeat stability, independent
   and swapped-root isolation, JSON escaping boundaries, same-realpath aliases,
   identical resolved roots across config/environment provenance, and unchanged
   identity when only root-versus-legacy state-file selection changes.

5. `src/adapters/codex/state-snapshot.ts`, `state-db.ts`, and `fingerprint.ts` —
   first pass the mutation-free active-WAL feasibility gate above, then build the
   state gateway exclusively over one private snapshot per discovery generation.
   Materialize an immutable adapter-private row/edge map and dispose staging
   before yielding; candidate reads require matching frozen descriptors and never
   reopen the state database. Use stable schema/row/edge snapshots, dynamic SQL
   limited to feature-detected
   identifiers, binary thread ordering, strict runtime type admission, canonical
   absent values, and bigint-safe hashing. Implement the exact column map,
   timestamp precedence, and tuple order above; no other state field may enter
   normalization or candidate fingerprints. Tests mutate every consumed field
   independently, prove shadowed/unconsumed changes do not invalidate
   candidates, distinguish missing edge table/row/status capability, reject
   ambiguous multiple parents and malformed schemas, and prove closed/live-WAL
   snapshots, cross-table committed-generation consistency under concurrent
   writer/checkpoint/WAL reset, retry/failure mapping, cleanup, one copy per
   discovery rather than per candidate, and provider byte/metadata immutability.

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
     explicit inter-agent text; ordered input/output text plus exact image/opaque
     omissions; explicit provider instruction fields/roles retained as injected
     content, not stripped;
   - canonical tools: function/custom calls and results only, with exact call
     IDs, separate names/namespaces, exact argument text, ordered supported result
     text/omissions, non-adjacent and result-before-call backfill, and unmatched
     evidence without invented status;
   - deferred tools: the matrix's exact local-shell, dynamic/MCP, tool-search,
     web-search, image-generation, exec, patch, view-image, review, collaboration,
     and sub-agent discriminators become one privacy-safe unknown omission each.
     M5 does not inspect their fields or claim execution linkage;
   - canonical markers: task/turn start, complete, abort, compaction, and
     rollback, with exact-ID relations where available and no success inference;
   - visible evidence: explicit reasoning summaries only;
   - known omission: encrypted/hidden response reasoning, world state, raw
     reasoning events, replacement history, provider caches, tool catalogs, and
     unsupported opaque payload content;
   - forward compatibility: unknown outer/payload variants become `unknown`
     entries containing one non-searchable omitted segment; its class is
     `unknown` and its source type is the adapter-normalized structural
     discriminator or `unknown-record`, never raw payload data. Unknown nested
     items always use `unknown-content-item`. These records clear adjacency;
     malformed shapes of recognized variants fail the session.

   Codex omissions use this closed M5 mapping; new literals require a support-doc
   and fixture change rather than copying a provider value:

   | Evidence                                    | Class        | Source type                                                                   |
   | ------------------------------------------- | ------------ | ----------------------------------------------------------------------------- |
   | response/result or event remote image       | `image`      | `input-image`                                                                 |
   | event local-image array                     | `image`      | `local-image`                                                                 |
   | reasoning content / encrypted reasoning     | `unknown`    | `reasoning-content` / `encrypted-reasoning`                                   |
   | encrypted agent/tool/compaction content     | `unknown`    | `encrypted-agent-content` / `encrypted-tool-content` / `encrypted-compaction` |
   | unknown nested message/reasoning/agent item | `unknown`    | `unknown-content-item`                                                        |
   | unknown nested result item                  | `structured` | `unknown-content-item`                                                        |
   | deferred/unknown structural record          | `unknown`    | normalized discriminator or `unknown-record`                                  |

   Golden tests prove safe snake-to-kebab conversion and exact safe-kebab
   preservation only for unknown structural discriminators. Path-like, URL-like,
   control-containing, uppercase, Unicode, repeated-separator, and oversized
   values become `unknown-record` without leaking the rejected input. Known
   records with a missing/non-string required discriminator remain malformed.

   Collapse only an adjacent, cross-family event/response message pair whose
   actor and complete ordered segment kind/value, origin, and confidence match
   exactly; retain the response-item projection. Preserve same-family and
   non-adjacent repeats. Preserve every compaction representation. A state spawn
   edge produces one high-confidence parent relation; no reciprocal child,
   inferred fork, inferred replay, or text-based lineage. Golden fixtures cover
   every supported outer/response/event discriminator and alias, every nested
   discriminator, every exact deferred discriminator through a table-driven
   unknown case, the complete exact skip set through table exhaustiveness plus a
   representative no-entry case, malformed listed fields, source metadata and
   timestamps, multi-segment order, linkage, and duplicate ambiguity.

8. `src/adapters/codex/source.ts` — compose probe/discover/read over those modules
   and expose `createCodexSource()` through the existing internal
   `SessionSource` port. Discovery reads state rows and file metadata only, emits
   deterministic candidates including missing/invalid rollouts, and never reads
   transcript content. Discovery receives only the provider-neutral private-
   directory capability, never `IndexPaths` or the scratch root. Read consumes
   frozen state and owns live rollout pre/post verification, then maps failures
   to the shared sanitized error union. Extend
   the shared source conformance suite with explicit frozen-snapshot versus live-
   input fixture modes: row/edge changes after discovery do not alter the current
   read and appear on the next discovery, while stale candidate descriptors and
   rollout representation/path/byte changes fail deterministically. Increment
   one explicit adapter format version whenever normalization semantics change.

9. `src/application/ports/session-index.ts`,
   `src/application/ports/index-lifecycle.ts`, a focused provider-neutral library
   maintenance port,
   `src/infrastructure/sqlite/sqlite-session-state.ts`,
   `src/infrastructure/sqlite/sqlite-session-index.ts`, and
   `src/infrastructure/sqlite/database.ts` — replace `removeSession` with
   non-destructive `recordMissing`; make run start/interrupt record unknown source
   coverage and complete finalization record complete coverage; update every
   discovered outcome's presence/last-seen and every replacement's capture time.
   Add the exact M5 index report's `missing` count/items and coverage while
   reading legacy `removed` history without emitting it as current output.
   Derive every library observation/capture field from the run's application-
   owned `startedAt`; never use the SQLite lifecycle clock for those fields. Add
   `listSummaries({ limit })` with effective source state, freshness, and capture
   time and implement the locked raw-tuple bound/order inside SQLite. Add
   `src/application/list-sessions.ts`, `show-session.ts`, `forget-session.ts`, and
   renamed all-data-clear reports, plus a shared lifecycle helper only where it
   preserves open/operation/close aggregation. Forget acquires its own fenced
   lease, never creates an index run, and performs the locked deletion,
   omitted-count compensation, and content collection in one immediate
   transaction. Run-record health validates the post-forget equation. Tests use
   deliberately divergent application/lifecycle clocks and multiple candidates
   to prove the shared observation instant, exact complete/incomplete/interrupted
   transitions, migrated nulls, and capture preservation across unchanged,
   failure, missing, replacement, and reappearance. Equal-time identities whose
   raw and printable orders differ (`z` and `é`) straddle a SQL limit boundary to
   prove activity/null ordering, raw-tuple tie-breaks, bounded `N + 1`, and no
   post-limit reorder. Also prove truncation, idempotent forget/clear, missing
   state/identity/entry behavior, close on all paths, and no source-adapter
   dependency outside indexing. Parameterized lease tests cover every live and
   expired matrix cell, mutation-free denial, generation takeover, stale-owner
   fencing, active-run interruption, expired-clear recovery, forget heartbeat/
   release/close aggregation, and committed-before-crash idempotence. List first
   uses non-mutating `inspect`: uninitialized short-circuits to the exact empty
   result without `openReader`; ready uses the strict snapshot reader; all other
   states retain existing lifecycle failures. Do not weaken `openReader` or add a
   synthetic empty repository. Extend `IndexPaths` with the exact owned scratch
   root and `IndexWriter` with `SourceDiscoveryWorkspace.withPrivateDirectory()`;
   `runIndex` passes it into the source port only after writer open. The writer
   lifecycle owns lease-scoped prepare/callback/close cleanup; adapters never see
   paths, and canonical repositories/query services never receive the workspace.

10. `src/infrastructure/state/paths.ts`, state/lifecycle values, and path tests —
    implement the application-data and `SESSIONS_DATA_DIR` contract above and
    rename the owned database to `sessions.sqlite3`. Add the exact `.scratch`
    child to `IndexPaths`, paths schema 2, lease-scoped writer cleanup, and
    data-clear report. Preserve non-mutating path inspection, safety checks,
    POSIX modes, and only-known-file scope except for recursive removal of this
    one validated Sessions-owned scratch root without following symlinks. Do not
    inspect, migrate, or remove the prior cache. Bump paths structured output to
    the exact schema-2 `library`/`sources` report above rather than silently
    changing schema 1. Remove valid schema 3 from non-current direct clear;
    schemas 3 and 4 cannot be unlinked until clear owns their existing carried
    lease. Clear removes scratch under active heartbeat, crosses destructive
    intent, then stops heartbeat, refreshes/asserts ownership, checkpoints,
    closes, and verifies post-close file identities/the immutable lease
    immediately before unlink. It never removes orphan scratch without a lease-
    bearing database. Keep pre-lease legacy schemas separately classified.

11. Extract `src/application/admit-source-probe.ts` from the private validator in
    `run-index.ts`; reuse it from indexing, `get-paths.ts`, and a new generic
    source diagnostic. Add sorted source status and only the Codex home/effective
    state roots to paths schema 2. Bump doctor output to schema 2, rename the
    machine-facing `index-state` check to `library-state`, distinguish canonical
    integrity from derived FTS integrity/remediation, and add `source-codex` after
    existing runtime/library checks using the exact details unions above.
    Unavailable, unreadable, malformed, and thrown probes become sanitized failed
    checks. Tests prove no rollout read, no
    state creation/migration, stable ordering, canonical preservation under an
    FTS-only rebuild fixture, and no raw parser/path error leakage. Health tests
    lock `forget-live`, prove active runs are healthy only with `index-live`, and
    never expose lease owners/timestamps.

12. Split `src/cli/program.ts` into focused command registration and human/JSON
    renderers while retaining `createProgram()` as orchestration. Add index,
    forget, data-clear, list, and show handlers to `src/cli/run.ts`; generalize
    `OperationalExit`; validate all numeric/source/identity arguments before
    opening state. Add a central terminal-safe, UTF-8-bounded scalar renderer.
    CLI tests lock generated help, nested data-clear routing and mandatory `--yes`,
    the command semantics and exit codes above, stdout/stderr separation, report
    completeness and every exact M5 JSON schema/union, source-state/capture
    rendering, bounds, the exact fresh-list `No sessions found.\n`/empty-stderr/
    exit-0 contract, and ANSI/control/prompt-like transcript handling. There is no
    `index clear` alias.

13. `src/bin/sessions.ts` — remain the only composition root and the only place
    that imports Codex. Register a lazy `codex` source factory: help, version,
    list, show, forget, and data clear must not resolve config or touch provider
    paths; index, paths, and doctor load/probe intentionally. Compose the adapted
    SQLite writer, reader, forget, and all-data maintenance implementations
    without adding provider branches to them. A fresh list composition test proves
    the data root remains absent and the lazy Codex factory is never resolved.

14. `test/fixtures/codex/`, `test/adapters/codex/`, and end-to-end CLI tests —
    generate minimal base/current/optional-column SQLite databases and synthetic
    JSONL/Zstandard rollouts; never copy local material. Prove index -> list ->
    show; remove one provider row and index again, proving missing state and
    identical retained content; repeat missing idempotently; restore unchanged and
    changed rows; poison or interrupt discovery and prove unknown coverage with no
    deletion; fail a discovered read and prove present-plus-stale. Give the
    forget target an outgoing relation, a relation targeting it from another
    retained session, shared and exclusive content, and a finished failed/stale
    run item. Forget once and prove tracking/owned canonical evidence/run-item
    detail disappear, the incoming relation and aggregate run counts remain,
    omitted count increases once, exclusive content/FTS is collected, shared
    content remains, and foreign-key/FTS/run health is clean. Forget again is an
    unchanged `absent`; recapture creates fresh tracking for the same printable
    identity without restoring redacted historical detail. Then data-clear and
    prove only Sessions-owned files disappear. Before/after recursive metadata
    snapshots must find no provider mutation or new sidecars.

15. `scripts/smoke-dist.ts` and `scripts/smoke-package.ts` — reuse the synthetic
    fixture builder to exercise doctor, paths, index, list, show, provider
    disappearance followed by another index, unknown coverage, forget/recapture,
    and data clear through compiled and offline packed installs. Keep smoke output
    content synthetic; begin with list against an absent data root and assert its
    successful empty output creates nothing. The packed CLI never depends on the
    source checkout or old cache location.

16. `package.json`, `pnpm-lock.yaml`, `README.md`, `docs/privacy.md`,
    `docs/reference/cli-contract.md`, `docs/contributing/adapter-contract.md`,
    `docs/contributing/architecture.md`, `docs/contributing/testing.md`, and the
    contributor index — add the reviewed TOML dependency and make current versus
    planned behavior honest. Document installation-to-first-durable-index usage,
    application-data ownership, provider-disappearance retention, explicit
    forget/data-clear behavior, Codex path precedence/support limits, human-only
    M5 list/show output, exact bounds, source read-only guarantees,
    omitted-content privacy, Zod/digest/export deferral, and the remaining M6–M8
    work. Update the roadmap/current-state labels only after the implementation
    checks pass.

## Verify

- Focused domain/storage gates:
  `pnpm vitest run test/domain/session-validation.test.ts test/application/validate-session.test.ts test/infrastructure/sqlite-canonical-library-evidence-migration.test.ts test/infrastructure/sqlite-session-index.test.ts test/infrastructure/sqlite-index-health.test.ts`.
- Lease/cutover gates:
  `pnpm vitest run test/infrastructure/sqlite-writer-coordination.test.ts test/infrastructure/index-maintenance.test.ts test/infrastructure/sqlite-lifecycle.test.ts`.
- Focused adapter gates: `pnpm vitest run test/adapters/codex` plus the shared
  source contract invocation. Run the state-snapshot feasibility file first and
  stop the milestone if it fails on any supported platform.
- Focused application/CLI gates:
  `pnpm vitest run test/application/list-sessions.test.ts test/application/show-session.test.ts test/application/forget-session.test.ts test/application/run-index.sqlite.test.ts test/infrastructure/state-paths.test.ts test/cli.test.ts`.
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
- Do not retain raw provider snapshots, attachment/media content, immutable
  revision history, a second archive database, automatic pruning, background
  capture, library import/restore, cross-machine sync, or destination-provider
  delivery. The verified process-private state database/WAL staging copy above is
  the only raw ephemeral exception; never copy rollouts or expose a restore path.
- Do not change query/storage policy for Codex. If a source format cannot enter
  the generic model, stop and review the model before adding an adapter special
  case.
- Stop if any provider path reaches SQLite, the state-snapshot feasibility proof
  cannot read active WAL without changing provider bytes/identity/mtime/ctime, an
  input consumed by normalization is absent from the candidate fingerprint,
  containment/identity cannot be proven, or rollout parsing requires an
  unbounded raw record/whole-file buffer.
- Do not pull M6 search/filter/recurrence, M7 document digest/export/final
  DTOs/`--full`, M8 Cursor, or packaged skill analysis into this change.
