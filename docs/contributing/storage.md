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
immutable. Doctor checks canonical and FTS health separately; an explicit index
writer may rebuild only FTS after canonical integrity passes.

## Guarantees and cost

- Hash or document mismatches, malformed stored values, and unsupported schema
  state fail closed.
- Content interning saves repeated text and keeps query support tied to one
  stable ID. It still compares text within a digest bucket for collision safety.
- FTS adds derived storage and write work in exchange for local full-text search.
  It can be rebuilt from canonical data; the inverse is not supported.
- Hashes detect mismatches. They are not encryption, identity, authenticity, or
  a privacy boundary.

## Code and tests

- Schema: `src/infrastructure/sqlite/migrations/0001-bootstrap.ts`
- Document storage: `src/infrastructure/sqlite/sqlite-session-document.ts`
- Digest codecs: `src/infrastructure/sqlite/sqlite-content-digest.ts` and
  `src/infrastructure/sqlite/sqlite-document-digest.ts`
- FTS: `src/infrastructure/sqlite/fts-projection.ts`
- Proof: `test/infrastructure/sqlite-canonical-migration.test.ts`,
  `test/infrastructure/sqlite-session-index.test.ts`,
  `test/infrastructure/sqlite-content-digest.test.ts`, and
  `test/infrastructure/sqlite-fts-repair.test.ts`
