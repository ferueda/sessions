# 0007 — Retain a durable canonical library

- Status: Accepted
- Date: 2026-07-14
- Supersedes: the rebuildable-state and automatic-removal consequences of
  [ADR 0001](0001-use-a-canonical-local-index.md)
- First-release consequence narrowed by:
  [ADR 0009](0009-establish-the-supported-release-baseline.md)

## Context

Sessions exists partly so users can recover and analyze conversations after a
provider no longer retains them. The original canonical-index decision treated
all Sessions state as rebuildable cache data. The implemented M4 reconciliation
therefore deletes a canonical document when a complete later source scan no
longer discovers it, and the owned database lives in an operating-system cache
location.

That behavior cannot provide durable local retention. Requiring a separate
archive action would also let users discover after provider expiry that they had
indexed a session without preserving it. Copying raw provider stores instead
would retain unnecessary private payloads, couple storage to unstable provider
formats, and provide no portable cross-provider representation.

## Decision

An explicit successful `sessions index` stores the latest successfully
normalized canonical session snapshot as durable Sessions-owned user data. The
provider source remains read-only input authority during capture; afterward the
canonical library remains available for list, search, show, analysis, and export
until the user explicitly deletes it through Sessions.

A complete source scan that no longer observes a known session records source
absence and capture metadata without deleting the canonical snapshot.
Unavailable, unreadable, malformed, or incomplete discovery does not establish
absence. Reappearance updates the same source-native canonical identity.

One SQLite database initially contains both lifecycles:

- durable canonical sessions, entries, provenance, capture metadata, and a
  deterministic document digest;
- rebuildable FTS/query projections and bounded operational diagnostics.

The database lives in the platform application-data location rather than an
operating-system cache. Rebuilding derived search state never deletes canonical
sessions. Only explicit forget/data-clear behavior removes retained transcript
content; no automatic TTL, pruning, or provider-deletion propagation applies.

V1 retains one latest successful normalized snapshot per canonical identity, not
an immutable copy of every observed revision. It stores canonical evidence, not
raw provider databases, rollout payloads, attachment bytes, media references, or
provider bookkeeping.

Codex active-WAL capture may temporarily copy its state database/WAL—not rollout
transcripts—into the exact permission-restricted Sessions-owned `.scratch`
subtree. This is execution workspace, not retained library data: normal capture
removes it before yielding, writer close attempts root removal before lease
release, the next leased index sweep removes crash residue, and explicit data
clear owns the same exact subtree. Provider SQLite and SHM are never opened by
Sessions.

Provider-neutral export projects the same canonical snapshot into versioned
Markdown, JSON, or JSONL. Export includes identity, capture and source-observation
state, canonical ordering, provenance, omissions, truncation, lineage, adapter
version, and document digest while excluding diagnostic source locators and
local paths by default. Sessions does not deliver the artifact to another
provider, create a destination conversation, or execute its contents.

## Consequences

- Retention, absence reconciliation, deletion, paths, migrations, health checks,
  and export are core application/storage concerns; source adapters remain
  limited to probe, discover, read, and normalize.
- Before the first supported `0.1.0` release, one current baseline is recognized and
  earlier development databases fail closed; users may need a fresh library and
  reindex. The unsupported `0.0.0` bootstrap seed adds no promise. From `0.1.0`
  onward, schema upgrades and repair guidance must
  preserve canonical user data because reindexing may no longer be possible after
  provider expiry.
- Clear language must distinguish rebuilding derived search state from deleting
  retained data. Destructive deletion is explicit and scoped to Sessions-owned
  database/sidecar files, the exact ephemeral scratch subtree, or canonical
  identities.
- A retained snapshot protects against provider disappearance only after a
  successful capture. It is not an exact provider backup, revision history,
  encryption, forensic erasure, or protection against local disk loss.
- Markdown is the practical paste/attachment context form; JSON and JSONL are
  portable evidence formats. Destination-provider integration remains out of
  scope.
