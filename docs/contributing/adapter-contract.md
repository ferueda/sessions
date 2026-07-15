# Source adapter contract

Status: implemented internal contract with one conforming Codex adapter.

Adapters translate provider histories into canonical documents. They do not define indexing, storage, queries, rendering, or analysis policy.

## Port

`SessionSource` exposes:

- `kind`: open adapter identifier; never a closed Cursor/Codex union.
- `probe()`: return `ready`, `unavailable`, or `unreadable` plus sanitized source
  roots without reading transcript content or mutating state.
- `discover(workspace)`: yield candidates with identity, at least one ordered
  input descriptor, a complete aggregate fingerprint, and adapter format version.
  The provider-neutral workspace offers only
  `withPrivateDirectory(operation)` after writer open; probe/read receive none.
- `read(candidate)`: deterministically normalize one complete candidate into a canonical `SessionDocument`.

The port and values live under `src/application/ports/`; canonical transcript values live under `src/domain/`.

## Rules

- Provider sources remain read-only.
- Each candidate input records role, opaque locator, and fingerprint. The shared
  aggregate helper covers every declared ordered role/URI/record ID/fingerprint
  tuple. Adapter fixtures independently enumerate required inputs so metadata or
  lineage consumed by normalization cannot be omitted silently.
- Parser behavior changes increment the adapter format version.
- Discovery order does not change canonical results.
- Reads compare every input before and after consumption or use an equivalent
  stable snapshot. Any mismatch or disappearance is `source-changed`.
- A stable-snapshot adapter materializes the complete declared logical input for
  one discovery generation before yielding. Candidate reads require matching
  frozen descriptors; state changes after capture are observed on the next
  discovery, while remaining live inputs still receive pre/post verification.
- The workspace implementation asserts the writer lease before allocation and
  after private random-directory cleanup in `finally`, returns a callback result
  only while ownership remains valid, and aggregates applicable
  operation/cleanup/lease failures. The adapter never sees its root, lease
  identity, or cleanup policy.
- Missing optional metadata maps to absent/unknown values. Every document declares
  immediate rootward lineage coverage as `complete` or `unknown`; an empty
  relation list proves a root only when provider evidence supports complete
  coverage.
- Discovery reports source evidence only. Adapters never decide whether an unseen
  canonical session is retained, marked missing, or explicitly deleted.
- Origin, relations, and lineage coverage are classified only when source
  evidence supports them. Adapters do not resolve roots or infer inverse/content-
  based lineage.
- Unavailable, unreadable, malformed, source-changed, and unsupported-format
  failures use the shared discriminated error contract and sanitized messages; no
  partial document is admitted.
- Entry and segment ordinals are contiguous and zero-based. Observed timestamps
  use exact UTC ISO form with milliseconds.
- Adapters use the core `sha256-utf8-v1` helper for exact canonical text and the
  application boundary recomputes every hash.
- Adapters import application/domain only—never Sessions SQLite persistence,
  retention, query, CLI, another adapter, or the composition root. Composition
  may pass an opaque, lease-scoped execution workspace; this does not let the
  adapter resolve paths or own durable state.
- Adapter output contains canonical content and diagnostic source metadata, not complete raw payload copies.

## Conformance proof

The reusable contract suite proves probe safety, deterministic discovery/read,
declared-input coverage, aggregate invalidation, typed failures, missing metadata,
ordering, provenance fallback, and read-only behavior. Fixtures declare each
input as live or snapshot-owned: live inputs must pass pre-read/during-read checks;
snapshot-owned inputs must remain deterministic from the frozen generation and
surface changes on the next discovery. Its synthetic source proves the contract
now; every concrete adapter must invoke the same suite alongside provider-
specific golden fixtures that enumerate every input affecting normalized output.
The Codex adapter runs both proof layers against generated SQLite and plain/Zstd
rollout fixtures. Fixtures contain no personal paths or transcripts.

The V1 contract is internal. A public plugin ABI is deferred until multiple independent adapters prove the boundary.

## Canonical tool and omitted-content evidence

The provider-neutral entry, validation, schema, and repository contracts support
generic `tool-call` and `tool-result` evidence. A call may carry its exact
source-observed tool name,
optional exact namespace, and provider call ID; results link to calls through
canonical entry relations and available call IDs. Name and namespace remain
separate, exact, and valid only on calls; namespace requires a name. Adapters do
not split, concatenate, or infer identity, and results do not copy it. Arguments
and results remain faithful ordered content.

Canonical content is an ordered union of text and omitted segments.
Text retains exact bytes and hashes and alone participates in FTS, deduplication,
and recurrence. Omitted segments preserve position, broad non-text class,
provenance, and a 1–64-byte lower-ASCII kebab source type matching
`^[a-z0-9]+(?:-[a-z0-9]+)*$` without bytes, URLs, paths, placeholder text, or
hashes. Use adapter-owned fixed labels. A forward-compatible discriminator may
be admitted only from a format-declared structural `type`, with a fixed fallback;
never derive a token from payload text, arbitrary keys, paths, URLs, or MIME
values. Domain/storage admission preserves valid tokens exactly and rejects
invalid ones. Adapters never open or fetch referenced media.

Adapters populate only evidence their source exposes. Injected tool or skill
catalogs remain injected content, and user requests or model declarations remain
content signals; none implies an invocation. The shared conformance suite will
cover linked events, missing tool identity, same-name tools in different
namespaces, ordered mixed text/non-text content, mention-only content, and
unavailable execution evidence without embedding skill policy in adapters.

## Codex implementation

`src/adapters/codex/` resolves one global/default Codex instance, probes its
roots, snapshots active SQLite/WAL state into the leased private workspace,
feature-detects supported thread/edge columns, and discovers ordered candidates.
Reads verify live rollout identity before and after streaming plain JSONL or
Zstandard data and normalize only declared record variants. `codex-v3` preserves
the V2 spawn-edge coverage contract: table absence remains unknown while row
absence in a supported table can be complete. V3 also accepts independently
validated, non-empty `session_meta.session_id` group identity that may differ
from the thread `id`. Only `id` supplies thread identity; the group value is
neither projected nor treated as lineage. Retained V2 candidates re-normalize
once under V3, then unchanged inputs skip rollout reads again. Unknown supported
structural records become privacy-safe omissions; malformed or changing evidence
returns a typed failure and never a partial document.

The adapter imports only application/domain contracts. It never opens the
Sessions database, decides retention or source absence, renders output, or owns
durable files. See the
[format support reference](../reference/codex-format-support.md) for its current
compatibility boundary.
