# 0001 — Use a canonical local index

- Status: Accepted
- Date: 2026-07-13

## Context

Provider histories are mutable, differently shaped, and expensive to scan repeatedly. Reopening them for show/export can produce results inconsistent with the indexed search snapshot.

## Decision

Use a Sessions-owned SQLite database with FTS5 as the canonical query store. Index only after an explicit command. Source histories stay read-only. List, search, show, and export read the index; adapters never write it. Index updates are incremental, idempotent, transactional, adapter-version aware, and preserve last-good documents after failed refreshes.

## Consequences

Results are stable across commands and providers, and local state is rebuildable. Sessions must own migrations, permissions, reconciliation, clearing, and honest deletion limitations. FTS5 becomes a runtime capability checked by doctor.
