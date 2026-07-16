# Add any-term search, query roots, and activity bounds

## Goal

Complete M8 corpus selection so agents can find sessions containing any of several
literal terms, group list/search results by retained lineage root, and restrict
list/search/entries to real session activity. Keep today’s literal-all search as
the default and preserve its ranking, support, context, and ordering. Every new
query remains provider-neutral, index-only, bounded, cursor-safe, and available
through human, JSON, and JSONL output.

This is a pre-alpha public contract extension. Schema 1 may reset before its first
publication: list items and search hits gain required root attribution, and search
matches gain required matched terms. Canonical documents, document digests,
show/export records, and SQLite storage do not change.

## Changes

1. `src/domain/session-query.ts` and the list/search application services — add
   `all | any` search-term admission, shared activity bounds, and query-derived
   roots at the provider-neutral contract boundary. `all` remains the default.
   Admit at most 32 Unicode-whitespace terms and 4 KiB of canonical UTF-8 search
   text before SQLite opens. Search hits report the first-query-order set of
   exact, duplicate-free input terms that matched any eligible text occurrence
   in the primary hit’s entry. Add exclusive `activityAfter` / `activityBefore`
   values to the shared session filter, defined only as `updatedAt` falling back
   to `createdAt`; a session missing both never matches. Bind mode and activity
   bounds into cursor fingerprints. Add root beside list summaries and search
   hits without adding it to the shared summary used by show/export, and copy and
   freeze every new value through the application layer.

2. `src/infrastructure/sqlite/literal-fts-query.ts`,
   `sqlite-query-filters.ts`, `sqlite-query-lineage.ts`, and
   `sqlite-session-query.ts` — keep quoting each public term as FTS data; join
   with the existing `AND` expression for `all` and a literal `OR` expression for
   `any`. Use the full expression unchanged for FTS5 BM25 rank, one-hit-per-entry
   grouping, snippets, support, and pagination. After page selection only,
   determine `any` hit terms with bounded candidate-local FTS probes over the
   selected `(session_id, entry_ordinal)` coordinates, including the matching
   occurrence-origin predicate when present; never infer terms by parsing a
   snippet. Repeated terms and multi-term content must not duplicate hits or any
   occurrence/content/root support unit. Build one retained root resolver per
   non-empty query: list reuses it across its page, while search reuses the same
   resolver for query-wide support and hit attribution. Apply activity bounds
   through `COALESCE(canonical.updated_at, canonical.created_at)` in the shared
   SQL filter. Do not add a schema migration or activity index without measured
   plan evidence; current search and entry plans already join canonical rows by
   identity, and the focused baseline is about 11.5 ms for a 2,000-session broad
   search and 2.6–3.9 ms for 10,000 entry rows on this machine.

3. `src/cli/program.ts`, `render.ts`, `structured-output.ts`, and
   `src/bin/sessions.ts` — add `search --match all|any` with default `all`, plus
   shared `--activity-after` / `--activity-before` options for list, search, and
   entries. Invalid modes, limits, timestamps, and equal/reversed bounds are
   usage errors before handlers run. Human list/search output prints one escaped
   known root or `unknown`; search also prints its escaped matched terms. Reuse
   one strict command-neutral root DTO for list, search, and entries. Preserve
   `PublicSessionSummaryV1` and snapshot/export types; make root required only on
   list-specific summaries and search/entry results, and add matched terms under
   each structured search match. JSON and JSONL remain equivalent, exact,
   recursively validated, frozen, and subject to the existing 16 MiB atomic
   output limit.

4. `test/fixtures/session-query-corpus.ts`,
   `test/contracts/session-query.contract.ts`, and focused domain/application/
   SQLite/CLI/structured-output tests — prove default-all output and rank remain
   unchanged; any-mode overlap does not double-count; terms found in separate
   qualifying segments of one entry are reported together; exact duplicate,
   punctuation, quote, zero-token, origin, tool, linked-context, 32-term, and
   4-KiB cases behave as specified; mode or activity changes invalidate cursors;
   and the activity fallback, missing/equal timestamps, AND composition, search
   support, and entry first/last behavior are exact. Use the existing retained
   lineage corpus to prove identical known/unknown roots across list, search, and
   entries, agreement between per-hit roots and search support, one resolver per
   query, strict invalid-root rejection, private-field exclusion, terminal-safe
   human output, and no root in show/export or document digests.

5. `scripts/measure-search-query.ts`, `scripts/measure-entry-query.ts`, and
   `scripts/smoke-workflow.ts` — keep deterministic correctness assertions while
   adding a bounded multi-term any search, activity-qualified query cases, and
   list/search root checks. Report elapsed measurements only; do not create a
   timing threshold or durable index from one machine’s result. Distribution and
   packed-package smoke must prove the flags and exact JSON/JSONL evidence without
   provider resolution or provider-tree mutation.

6. `README.md`, the CLI/structured-output/privacy references, contributor search
   and architecture docs, the architecture memo, and the V1 roadmap — document
   exact current syntax, matched-term meaning, activity-time distinction, root
   attribution, costs, and pre-alpha schema reset. Mark M8 complete only after
   all three behaviors and delivery proofs pass, make M9 the next work, then
   remove this completed executor plan and reconcile `dev/plans/README.md`.

## Verify

- `pnpm test test/domain/session-query.test.ts test/infrastructure/sqlite-session-query.contract.test.ts test/infrastructure/sqlite-session-query.test.ts test/application/list-sessions.test.ts test/application/search-sessions.test.ts test/application/list-session-entries.test.ts test/cli.test.ts test/cli-render.test.ts test/cli-structured-output.test.ts`
- `pnpm measure:search-query`, `pnpm measure:query-lineage`, and
  `pnpm measure:entry-query`; compare exact correctness with the recorded baseline
  and treat elapsed time as directional evidence only.
- `pnpm check`
- Run aggregate-only, index-read-only list/search/entries dogfood against an
  existing ready library; do not print private transcript text, identifiers, or
  paths in review evidence.

## Boundaries

- No adapter change, provider access, canonical/FTS schema change, new index,
  migration, document-digest change, semantic search, raw FTS syntax, workflow
  classification, or analysis policy.
- No root filter, relation-body traversal, inferred lineage, cross-command cache,
  or root field in show/export. A reported root may fall outside the query
  filters because it is attribution, not another matching result.
- No timing SLA. Exact ranking, grouping, support, cursor, and evidence behavior
  take priority over a measured speedup.
