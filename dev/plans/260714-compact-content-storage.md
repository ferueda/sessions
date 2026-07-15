# Compact collision-safe canonical content storage

## Goal

Replace the current `UNIQUE (hash_scheme, digest, text)` content key, whose
exact-text autoindex accounts for 1,031,917,568 bytes of the audited
2,388,115,456-byte library, with compact digest buckets that preserve every
canonical behavior. The target keeps `content_id` as the integer occurrence,
query, and external-content FTS identity; stores the fixed SHA-256 digest as a
32-byte BLOB; narrows lookup through a non-unique digest index; and requires
exact `BINARY` text equality before reuse. Unequal text under a digest collision
must coexist, while equal text keeps one ID and one unique-content support unit.

This is a clean pre-launch baseline replacement, not a data migration. Keep
schema version 1 and change its checksum. An existing development database with
the old checksum becomes incompatible: indexing and reads fail closed, and the
current `data clear` path also rejects it as invalid rather than deleting it
(`src/infrastructure/sqlite/index-maintenance.ts:inspectDatabaseSchema`). The
supported reset is a fresh `SESSIONS_DATA_DIR` or manual removal of only the
exact obsolete Sessions-owned directory followed by reindexing; provider data
remains untouched.

## Changes

1. `src/infrastructure/sqlite/migrations/0001-bootstrap.ts:bootstrapMigration`
   — replace the content-values tuple constraint in the sole baseline: retain
   `content_id INTEGER PRIMARY KEY` and exact `text TEXT COLLATE BINARY`, remove
   the repeated hash-scheme/hex-digest columns, add a STRICT 32-byte BLOB
   `digest`, and add a non-unique digest index. Add a canonical `BEFORE INSERT`
   trigger that aborts only when the same digest and exact `BINARY` text already
   exists. The trigger is the database backstop for exact interning; digest
   alone is never unique, and no collision ordinal or bucket table is added.
   Keep the trigger outside `FTS_PROJECTION_SCHEMA_SQL` so projection repair
   cannot drop or recreate canonical policy. Preserve the occurrence foreign
   key, integer IDs, and existing FTS insert/delete/immutability triggers.

2. `src/infrastructure/sqlite/sqlite-content-digest.ts` and
   `src/infrastructure/sqlite/sqlite-session-document.ts:prepareContentStatements`
   — add one focused storage codec and use it for interning/reconstruction. The
   encoder accepts only the admitted 64-character lowercase hex digest and
   emits 32 bytes; the decoder accepts only a 32-byte `Uint8Array`, emits
   lowercase hex, and derives the single `CONTENT_HASH_SCHEME`. Do not rely on
   `Buffer.from(value, "hex")` without prior validation. Replace insert-first
   `ON CONFLICT` with a digest-indexed lookup using exact `COLLATE BINARY` text,
   deterministic `content_id` order, and a two-row limit: zero matches inserts
   and returns the rowid, one reuses it, and more than one fails closed as
   corrupt canonical state. Keep this synchronous helper private to the SQLite
   document owner and inside the existing leased `BEGIN IMMEDIATE` replacement
   transaction. Preserve replacement ordering from PR #14—capture prior IDs,
   cascade the old document, intern the complete replacement, then prune only
   prior IDs still unreferenced—so shared/reintroduced IDs, unrelated orphans,
   rollback, and last-good failure recording remain unchanged. Reconstructed
   documents must still pass `validateSessionDocument`, including exact
   text/hash recomputation.

3. `test/infrastructure/sqlite-content-digest.test.ts`,
   `test/infrastructure/sqlite-canonical-migration.test.ts`, and
   `test/infrastructure/sqlite-session-index.test.ts` — prove the new codec,
   schema, and repository behavior at their stable seams. Cover lowercase-hex
   round trip; rejection of malformed hex, non-`Uint8Array`, and 31/33-byte
   BLOBs; non-unique digest index shape; trigger rejection of an exact
   duplicate; and distinct IDs/FTS rows for unequal forced-collision text.
   Keep forced digests labeled as storage-seam corruption fixtures, not valid
   canonical documents. Exercise production lookup by seeding an unreferenced
   unequal bucket member under a valid document's digest, then prove valid
   indexing does not merge it, exact repeats reuse one ID, and canonical reads
   still validate. Retain the existing shared/reintroduced content-ID,
   candidate-scoped cleanup, unrelated-orphan, FTS consistency, forced rollback,
   and retry assertions with the BLOB representation.

4. `test/infrastructure/sqlite-session-query.test.ts`,
   `test/infrastructure/sqlite-fts-repair.test.ts`,
   `test/infrastructure/sqlite-index-health.test.ts`, and
   `test/infrastructure/index-maintenance-forget.test.ts` — update direct schema
   fixtures and protect unchanged cross-lifecycle behavior: support still counts
   distinct `content_id`; FTS keeps `content_rowid='content_id'`; insert/delete
   triggers and canonical-only rebuild stay synchronized; the canonical
   duplicate guard survives projection rebuild; referenced malformed stored
   digests fail canonical health/read checks; and forget removes only
   unreferenced values while retaining shared text. Add a regression that the
   old baseline checksum is refused without mutation and that current
   `data clear` does not claim or perform a reset of that incompatible file.

5. `scripts/measure-content-storage.ts`, `package.json:scripts`, and
   `docs/contributing/commands.md` — add an opt-in, deterministic
   `pnpm measure:content-storage` comparison, outside `pnpm check`. Generate only
   generic temporary SQLite data, clean it in `finally`, and compare the legacy
   exact-text key with the actual migrated target schema at a fixed 4 KiB page
   size. The realistic corpus is exactly 50,000 unique values and 155,000 intern
   operations: 60% of texts are 256 UTF-8 bytes, 25% are 2,048 bytes, 10% are
   8,192 bytes, and 5% are 16,384 bytes (2,304-byte average, approximating the
   audited 1,077,325 occurrences / 347,500 unique values and 2,255-byte average).
   The separate storage-seam collision corpus is exactly 10,000 unequal
   128-byte values, 31,000 intern operations, and 100 forced digest buckets with
   100 members each. Use deterministic generic text/digest generation and the
   same pragmas for both layouts. Report only aggregate corpus parameters,
   per-object/file bytes, and elapsed time; never emit generated text, digests,
   identities, or paths. Assert equal-content ID reuse, unequal-collision
   coexistence, absence of any target index keyed by text, and a target
   realistic database no larger than 60% of the legacy database. The relative
   size criterion leaves margin above the observed 48.3% while proving material
   removal of the full-text B-tree; elapsed time remains report-only with no
   threshold, and exact byte totals are not pinned across SQLite/platform
   versions.

6. `docs/contributing/architecture.md` and
   `dev/plans/260713-v1-implementation-roadmap.md` — update current storage
   wording that would otherwise still describe exact text as an indexed key.
   Record digest-bucket lookup, exact-text equality, canonical duplicate guard,
   stable integer FTS identity, and the unchanged PR #14 cleanup boundary.
   Preserve the existing privacy/reset contract: older development databases
   are not migrated or automatically deleted, and unrecognized state fails
   closed. Land this baseline-schema change before the planned compaction and
   orphan-maintenance work; those plans must rebase on this schema/lease truth
   rather than extend the superseded baseline.

## Verify

- `pnpm test test/infrastructure/sqlite-content-digest.test.ts test/infrastructure/sqlite-canonical-migration.test.ts test/infrastructure/sqlite-session-index.test.ts test/infrastructure/sqlite-session-query.test.ts test/infrastructure/sqlite-fts-repair.test.ts test/infrastructure/sqlite-index-health.test.ts test/infrastructure/index-maintenance-forget.test.ts`
- `pnpm measure:content-storage` and confirm its fixed-corpus structural,
  identity/collision, and target-size-at-most-60%-of-legacy assertions; inspect
  elapsed time only as aggregate evidence, never as a gate.
- `pnpm check`

## Boundaries

- No compatibility migration, in-place live-library conversion, automatic
  reset, new schema version, or claim that `data clear` accepts the old checksum.
- No digest-only equality, collision ordinal, `WITHOUT ROWID` content table, or
  normalized bucket table.
- No CLI/query contract, FTS ranking/tokenization, domain hash policy,
  application port, adapter, provider-read, replacement/forget semantics, or
  privacy expansion.
- No physical compaction, orphan observability/repair, or metadata-retention
  work. Stop and reconcile if either follow-on plan changes shared schema or
  lease contracts before this baseline plan lands.
