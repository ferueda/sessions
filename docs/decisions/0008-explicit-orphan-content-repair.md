# 0008 — Make orphan-content deletion explicit

- Status: Accepted
- Date: 2026-07-15
- Extends: [ADR 0007](0007-retain-a-durable-canonical-library.md)
- First-release consequence narrowed by:
  [ADR 0009](0009-establish-the-supported-release-baseline.md)

## Context

ADR 0007 makes the normalized canonical library durable until the user explicitly
deletes evidence. SQLite can nevertheless contain a canonical content value that
no retained occurrence reaches. Such a row is schema-valid and can have a
matching FTS row, so canonical integrity, foreign keys, and FTS projection health
can all pass while unreachable text remains stored.

The audited library contained no orphan content, so this is resilience and
operability rather than a known normal-path leak. Per-session replacement and
forget must remain scoped to their former content IDs; turning either hot path
into a whole-library sweep would make routine latency scale with the entire
library. Whole-library clear is not a safe substitute because retained sessions
may no longer exist at their provider.

## Decision

Immutable doctor health reports canonical reachability separately from canonical
integrity, foreign keys, and FTS projection health. Its machine-facing fields are
`contentReachability`, `orphanContentRows`, and `orphanContentBytes`; any orphan
or inspection failure makes the library check unhealthy without exposing text,
identities, hashes, or paths.

`sessions data repair-orphans [--format human|json]` is the explicit,
provider-free deletion route. It holds a dedicated renewable `repair` writer
lease, shown by doctor as `repair-live`, and scans to completion through fixed
internal committed batches. Each candidate must still have no occurrence and
must have its expected FTS row before canonical deletion; existing canonical
delete triggers remove the derived row. Repair never rebuilds FTS.

The public operation has no limit, cursor, partial outcome, or progress token. A
failure emits no success report, but prior committed batches remain durable and a
fresh invocation safely restarts. Its aggregate deleted-row and deleted-byte
values are exact decimal strings. Deleted bytes mean logical UTF-8 canonical text
payload, not reclaimed database or filesystem space. `sessions data compact`
remains the separate explicit physical whole-page reclamation route.

This is a narrow extension of ADR 0007's explicit-deletion model. It does not
supersede durable retention, introduce automatic pruning, or broaden provider
access.

## Consequences

- The supported operational flow is doctor, explicit orphan repair, then doctor
  again to verify reachability.
- Replacement and forget remain candidate-scoped; no index, read, or per-session
  deletion hot path gains an automatic whole-library sweep.
- Canonical orphan deletion and FTS projection repair remain distinct. Missing or
  inconsistent candidate projection state blocks repair rather than triggering a
  rebuild.
- Logical deletion can make SQLite pages reusable but does not promise physical
  file shrink or forensic erasure; users invoke data compact separately when
  physical reclamation is useful.
- Before the first supported `0.1.0` release, the repository still recognizes one
  current schema baseline. Earlier development databases receive no compatibility
  migration or automatic reset and may require a fresh Sessions data directory
  and reindex. The unsupported `0.0.0` bootstrap seed does not change that
  boundary.
