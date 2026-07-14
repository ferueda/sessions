# Implement the canonical session repository

## Goal

Implement M3 from the V1 roadmap: advance the protected SQLite index from
migration metadata to one provider-neutral repository that can persist and
reconstruct complete canonical session documents, preserve last-good content
across failed refreshes, retain the durable state required by incremental
indexing, and maintain query-ready FTS5 data atomically.

Acceptance requires exact canonical round-trip, collision-safe content
interning, source-instance isolation, complete replacement/rollback, stale
last-good behavior, consistent cascade/FTS cleanup, bounded run diagnostics,
and application ports that expose no SQLite, FTS, Cursor, or Codex vocabulary.
M3 remains internal: generated CLI help still exposes only `doctor` and `paths`.

## Changes

1. `src/domain/session-validation.ts` and `src/application/validate-session.ts`
   — keep `validateSessionDocument` as the single canonical rule engine and add
   an application admission factory that snapshots and validates a discovered
   candidate into a readonly `SessionObservation` without requiring a document.
   Validate its identity, aggregate fingerprint, and adapter version so unchanged
   and failed candidates cannot bypass admission. A second factory composes that
   observation with a validated, deeply snapshotted canonical document into a
   branded replacement value for repository writes. Require every persisted
   string—including title,
   workspace, entry kind, tool IDs, locators, and source-metadata keys/values—to
   be well-formed Unicode without normalization; malformed values must remain
   bounded, path-only validation failures. Refactor
   `src/application/read-session-document.ts` to share this admission behavior
   rather than introducing a second validator. Apply the TypeScript refactor
   guidance for branded values, readonly shapes, and discriminated outcomes. Add
   bounded, path-only tests for malformed candidate-only observations and prove
   mutations after admission cannot change the persisted observation/document.

2. `src/application/ports/session-index.ts` and
   `src/application/ports/index-lifecycle.ts` — define provider-neutral business
   values and capabilities for indexed summaries, durable per-session freshness,
   runs, outcomes, and safe failures. Separate a reader capable of reconstructing
   summaries/documents/state from a writer that starts/finishes runs, records
   unchanged/failed outcomes, atomically replaces a validated document, and
   removes canonical content after confirmed reconciliation. Model last-good and
   latest-observation state explicitly so a failed first read has tracking but no
   document and a failed refresh retains the previous document. Removing a
   canonical document clears its last-good revision and records a removed latest
   state, preventing the same rediscovered revision from being skipped without a
   document. Expose these
   capabilities through lifecycle reader/writer handles; raw `DatabaseSync` stays
   on concrete infrastructure-only subtypes. Do not expose a generic transaction
   callback or query/ranking values.

3. `src/infrastructure/sqlite/migrations/0002-canonical-repository.ts` and
   `src/infrastructure/sqlite/migrations.ts` — append one immutable schema release
   for source instances; durable session identity/freshness; optional canonical
   session metadata; ordered relations and entries; collision-safe unique content
   keyed by hash scheme, digest, and exact text; content occurrences; index runs;
   and bounded diagnostic items. Use `STRICT` tables, binary/case-sensitive
   identity semantics, foreign keys, uniqueness/check constraints, and a
   storage-only relation ordinal for exact reconstruction. Store canonical source
   metadata as deterministic JSON, not raw provider payloads or exceptions.

   Create an external-content FTS5 table over unique content values, with
   migration-owned insert/delete triggers and an integrity-checkable rebuild path.
   Content values are immutable; repository orphan cleanup deletes the FTS entry
   and canonical row in the same transaction. The FTS tokenizer is a rebuildable
   M3 baseline, not the final M6 ranking/tokenization contract.

4. `src/infrastructure/sqlite/sqlite-session-index.ts` — implement the reader and
   writer ports with parameterized SQL. One `BEGIN IMMEDIATE` transaction replaces
   the entire canonical document graph, updates FTS-derived state through schema
   triggers, advances last-good/latest-success metadata, and records the run
   outcome. Any failure rolls back the old document and search rows; recording the
   failed latest observation is a separate transaction that never changes
   last-good metadata or content. New-session failures retain identity/tracking
   only. Derive staleness from last-good versus latest outcome rather than storing
   a drift-prone boolean.

   `recordUnchanged` and `recordFailure` accept only admitted observations;
   unchanged requires an existing document with an identical last-good revision.
   A replacement transaction failure rolls back first, then attempts a separate
   typed `repository-write` failure record and rethrows the original cause (or an
   aggregate preserving both causes when failure recording also fails). Callers
   must not record that failure twice.

   Intern content by `(scheme, digest, exact text)`; identical hashes never merge
   unequal text. Reconstruct every optional field, array order, entry relation,
   segment ordinal, provenance value, locator, and source-metadata record exactly.
   Relation targets may be absent from the index and remain provider-neutral
   identities. Removing a canonical document cascades entries/occurrences,
   garbage-collects newly orphaned content/FTS rows, and retains only the tracking
   and bounded run evidence needed by M4.

   Retain exact aggregate run counts, at most 100 detailed exceptional items per
   run, and at most 20 completed runs per source instance. Record omitted-item
   counts; exclude active runs from pruning. Current per-session freshness must not
   depend on retained run rows. Persist typed outcome/failure codes only—never
   transcript excerpts, adapter summaries, or raw exception messages. Follow the
   Node error guidance by preserving operation/rollback causes and aggregating
   independent cleanup failures.

5. `src/infrastructure/sqlite/database.ts` and
   `src/infrastructure/sqlite/fts5-security.ts` — construct the concrete session
   repository inside SQLite infrastructure and attach only its provider-neutral
   capability to application lifecycle handles. Writer open applies migrations,
   then enables persistent per-table FTS secure-delete when the runtime probe
   reports support. Unsupported runtimes open with an honest unsupported report;
   failure to enable the real migrated FTS table after support was confirmed must
   fail writer opening, preserve the cause, and run normal cleanup rather than be
   downgraded to unsupported.

   Add a non-migrating read handle for ready indexes without retaining an
   immutable SQLite connection. Each repository read performs path-safety and
   database/sidecar prechecks, opens one immutable connection for the complete
   operation, closes it, and verifies the same file snapshot and continued
   sidecar absence before returning. A detected change discards the result and
   rejects with a typed concurrent-change/recovery error. The handle must create
   no files or sidecars and close deterministically. Keep M2 path, permission,
   migration-history, and cleanup-error guarantees intact; split helpers instead
   of growing another monolithic lifecycle file.

6. `test/contracts/session-index.contract.ts`,
   `test/infrastructure/sqlite-session-index.test.ts`, and focused domain/lifecycle
   tests — run one reusable repository contract against SQLite. Prove complete
   round-trip with missing optionals and ordered relations; source-instance/native
   ID collisions; parameterized adversarial text; same digest/different text at
   the storage seam; unchanged state; failed first read; last-good/stale refresh;
   successful replacement; removal followed by rediscovery of the same revision;
   bounded diagnostics; and exact counts. The round-trip fixture includes a
   forward related-entry reference and a relation target absent from the index;
   database constraints must support both.

   Prove atomicity with a test-owned SQLite trigger that aborts mid-replacement,
   not a production fault-injection hook. Assert the prior document and FTS match
   survive rollback, obsolete terms disappear after success, cascades remove all
   owned rows, external-content `integrity-check` passes, and orphan content shared
   by another session remains. Await every asynchronous assertion and isolate each
   database/reader/writer fixture per the Vitest guidance.

7. Existing SQLite migration/lifecycle tests, smoke scripts, and current-behavior
   docs — cover migration from schema 1 to schema 2, fresh/reopen behavior, reader
   no-write behavior, a database change after the reader handle opens, unsupported
   FTS secure-delete, strict real-table enable failure, and the new supported
   schema version without weakening M2 proofs. Prefix successful custom migration
   catalogs with the full production catalog; construct the schema-1 migration
   fixture directly so the production repository capability never becomes
   optional. Update `README.md`, architecture/privacy/
   testing/CLI references, and the V1 roadmap to state that M3 is complete while
   indexing, reconciliation, adapters, and public query commands remain planned.
   Remove this executor plan and its active index entry once implementation and
   review pass; retain the program roadmap.

## Verify

- `pnpm vitest run test/domain/session-validation.test.ts test/application/read-session-document.test.ts test/infrastructure/sqlite-lifecycle.test.ts test/infrastructure/sqlite-session-index.test.ts`
- `pnpm check`
- Run the repository change-review workflow against `origin/main`; implementation
  and quality must pass on the final committed head with no `must_fix` findings.

## Boundaries

- No source discovery, indexing orchestration, reconciliation policy, clear-index
  command, interrupted-writer recovery, or public `sessions index` surface (M4/M5).
- No Cursor/Codex adapter or provider branch anywhere in domain, application,
  storage, query, or CLI code.
- No public list/show/search/export behavior, ranking, tokenizer tuning, snippets,
  pagination, root resolution, or recurrence aggregation (M5-M7).
- No canonical document version history, raw provider payload storage, generic
  unit-of-work API, or production-only test hooks.
