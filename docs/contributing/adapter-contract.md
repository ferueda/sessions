# Source adapter contract

Status: implemented M1 internal contract plus an accepted M5 tool-evidence
extension; no concrete adapter exists yet.

Adapters translate provider histories into canonical documents. They do not define indexing, storage, queries, rendering, or analysis policy.

## Port

`SessionSource` exposes:

- `kind`: open adapter identifier; never a closed Cursor/Codex union.
- `probe()`: return `ready`, `unavailable`, or `unreadable` plus sanitized source
  roots without reading transcript content or mutating state.
- `discover()`: yield candidates with identity, at least one ordered input
  descriptor, a complete aggregate fingerprint, and adapter format version.
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
- Missing optional metadata maps to absent/unknown values.
- Origin or lineage is classified only when source evidence supports it.
- Unavailable, unreadable, malformed, source-changed, and unsupported-format
  failures use the shared discriminated error contract and sanitized messages; no
  partial document is admitted.
- Entry and segment ordinals are contiguous and zero-based. Observed timestamps
  use exact UTC ISO form with milliseconds.
- Adapters use the core `sha256-utf8-v1` helper for exact canonical text and the
  application boundary recomputes every hash.
- Adapters import application/domain only—never SQLite, query, CLI, another adapter, or the composition root.
- Adapter output contains canonical content and diagnostic source metadata, not complete raw payload copies.

## Conformance proof

The reusable contract suite proves probe safety, deterministic discovery/read,
declared-input coverage, aggregate invalidation and pre-read/during-read checks
for every fixture-owned input, typed failures, missing metadata, ordering,
provenance fallback, and read-only behavior. Its synthetic source proves the
contract now; every concrete adapter must invoke the same suite alongside
provider-specific golden fixtures that enumerate every input affecting normalized
output. Fixtures contain no personal paths or transcripts.

The V1 contract is internal. A public plugin ABI is deferred until multiple independent adapters prove the boundary.

## Accepted M5 extension — not implemented

Before the first concrete adapter is normalized, the provider-neutral entry,
validation, schema, and repository contracts will add generic `tool-call` and
`tool-result` evidence. A call may carry its exact source-observed tool name,
optional exact namespace, and provider call ID; results link to calls through
canonical entry relations and available call IDs. Name and namespace remain
separate, exact, and valid only on calls; namespace requires a name. Adapters do
not split, concatenate, or infer identity, and results do not copy it. Arguments
and results remain faithful ordered content.

Canonical content will become an ordered union of text and omitted segments.
Text retains exact bytes and hashes and alone participates in FTS, deduplication,
and recurrence. Omitted segments preserve position, broad non-text class,
provenance, and sanitized source type without bytes, URLs, paths, placeholder
text, or hashes. Adapters never open or fetch referenced media.

Adapters populate only evidence their source exposes. Injected tool or skill
catalogs remain injected content, and user requests or model declarations remain
content signals; none implies an invocation. The shared conformance suite will
cover linked events, missing tool identity, same-name tools in different
namespaces, ordered mixed text/non-text content, mention-only content, and
unavailable execution evidence without embedding skill policy in adapters.
