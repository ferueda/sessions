# Storage

## Purpose

Sessions keeps a local canonical copy that remains useful when provider history
is unavailable. SQLite owns persistence; adapters only supply validated session
documents.

## Canonical records

- The library stores source tracking, the latest successful canonical document,
  relations, entries, content occurrences, run evidence, and the fixed public
  document digest.
- Text is stored once in `sessions_content_values`. Occurrences refer to its
  stable integer `content_id`. Non-text segments store omission facts, never the
  omitted media or resource.
- A text digest is stored as a 32-byte SHA-256 BLOB. The digest index narrows the
  lookup; exact binary text equality decides reuse. Unequal text with the same
  digest remains separate. A trigger rejects an exact duplicate row.
- The public document digest is separate from each text digest. A full read
  reconstructs and validates the document, then requires its computed digest to
  match the stored value.

Canonical replacement is one transaction. It captures the old document's
content IDs, replaces the document, then deletes only those old values that are
still unreferenced. Shared, reintroduced, and unrelated content is preserved.
A failed replacement rolls back without replacing the last good document.

## Search projection

FTS5 is derived from canonical text. Its row ID is the canonical `content_id`,
and insert/delete triggers keep both sides aligned. Canonical content values are
immutable. A changed-document transaction verifies the resulting document
digest and affected canonical/FTS row parity before commit.

Doctor checks canonical and FTS health separately. Its immutable semantic FTS
check loads canonical rows in bounded keyset batches into one complete,
contentless, memory-only TEMP FTS table. It streams matching row vocabularies,
then compares exact term instances in both directions through ranges capped at
1,000,000 occurrences per side or one oversized term; docsize is compared
separately in both directions. The complete expected table remains corpus-sized,
so total memory is not constant, but no expected or comparison state spills to
disk. An explicit index writer may rebuild only FTS after canonical integrity
passes.

## Writer proof state

Writer-lease acquisition makes its generation dirty. Only a normal index close
that still owns that exact generation can seal the database clean. It then
closes and hardens the database and atomically publishes a private post-close
proof bound to the library, generation, schema, and final database stat.

The proof contains bounded non-transcript metadata: no provider identity,
transcript text, path, content hash, or lease token. Its absence or rejection
only disables the fast path. A ready, sidecar-free, current-schema open with a
matching clean seal and proof uses constant-size schema/FTS structure checks;
the clean proof remains the preferred normal-open evidence.

Storage schema 3 also has one strict singleton index-generation receipt. Format
1 records only writer generation, schema version, SQLite schema cookie, and a
safe-integer operation sequence. Sequence zero is created after writer setup;
every supported index mutation advances it once in the same transaction as the
checked operation. The schema-2-to-3 migration does not backfill a receipt. Receipt
rows are rebuildable operational proof, not canonical evidence.

After ordinary SQLite WAL recovery, an exact receipt beside its expired index
lease may use bounded catalog and FTS structure checks and skip global canonical,
foreign-key, FTS content, and FTS semantic scans. Acquisition interrupts the
abandoned run, advances ownership, and clears the old receipt atomically. Free,
live, maintenance, migration-era, stale, malformed, wrong-schema/cookie, or
structurally invalid evidence cannot use this mode. Missing or altered receipt
table structure is repaired only under exact ownership and still requires the
complete validation/repair path before new proof is created.

A cooperative index cancellation uses the same exact-owner close path. It may
seal the cancelled generation only after active runs are interrupted, workspace
cleanup and heartbeat shutdown succeed, the database closes and hardens, and
transactional integrity remains certain. If any of those steps fails, no proof
is published. An abrupt process exit or `SIGKILL` may use certified recovery only
when it left the exact expired index owner and a matching receipt at a completed
mutation boundary; every other dirty state performs full validation.

## Guarantees and cost

- Hash or document mismatches, malformed stored values, and unsupported schema
  state fail closed.
- Direct SQLite edits outside Sessions are unsupported and are not guaranteed to
  be found by every clean or certified writer open. `doctor` is the explicit
  immutable full-library semantic check.
- Content interning saves repeated text and keeps query support tied to one
  stable ID. It still compares text within a digest bucket for collision safety.
- FTS adds derived storage and write work in exchange for local full-text search.
  It can be rebuilt from canonical data; the inverse is not supported.
- Hashes detect mismatches. They are not encryption, identity, authenticity, or
  a privacy boundary.

## Code and tests

- Schema: `src/infrastructure/sqlite/migrations/0001-bootstrap.ts`,
  `src/infrastructure/sqlite/migrations/0002-session-document-metrics.ts`, and
  `src/infrastructure/sqlite/migrations/0003-index-generation-receipt.ts`
- Document storage: `src/infrastructure/sqlite/sqlite-session-document.ts`
- Digest codecs: `src/infrastructure/sqlite/sqlite-content-digest.ts` and
  `src/infrastructure/sqlite/sqlite-document-digest.ts`
- FTS: `src/infrastructure/sqlite/fts-projection.ts`
- Writer state: `src/infrastructure/sqlite/writer-lease.ts`,
  `src/infrastructure/sqlite/writer-clean-proof.ts`, and
  `src/infrastructure/sqlite/writer-recovery-receipt.ts`
- Proof: `test/infrastructure/sqlite-canonical-migration.test.ts`,
  `test/infrastructure/sqlite-session-index.test.ts`,
  `test/infrastructure/sqlite-content-digest.test.ts`, and
  `test/infrastructure/sqlite-fts-repair.test.ts`, plus
  `test/infrastructure/sqlite-writer-recovery-receipt.test.ts`
