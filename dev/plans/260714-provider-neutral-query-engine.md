# Ship the provider-neutral query and evidence engine

## Goal

Complete M6 with one retained-library query path for deterministic lexical search,
filtered/paginated list, bounded evidence context, and honest recurrence measures.
The engine reads only canonical Sessions data; adapters do not rank, query, count,
render, or reopen provider histories.

Acceptance requires:

- `sessions search <text>` plus shared provider-neutral list/search filters;
- one stable search hit per canonical entry, with an index-backed snippet, exact
  coordinates/tool evidence, optional adjacent context, and directly linked
  call/result context;
- occurrence, unique-content, unique-known-root, and unknown-lineage-session
  counts over the complete filtered match set before pagination;
- deterministic ranking, opaque continuation cursors, and rejection of cursors
  from a changed query, changed library generation, or recreated library;
- canonical-only repair of damaged FTS projections during an explicit index
  writer operation; and
- corpus, query-contract, CLI, lineage, source-state, cursor, and repair proofs
  followed by `pnpm check`.

The repository is pre-release. Amend the single bootstrap baseline directly and
fail closed on obsolete development databases; do not build compatibility or a
migration path for the M5 schema.

## Public query contract

- `search` requires non-blank text. Split on Unicode whitespace, quote every
  term as FTS data, and combine terms with logical AND. Embedded quotes,
  operators, paths, IDs, and punctuation never become FTS syntax. A query that
  yields no tokenizer terms succeeds with no matches.
- One value per filter. Different filters combine with AND. Exact source,
  instance, workspace, entry-kind, tool-name, tool-namespace, and identity
  fields use their existing case-sensitive canonical values; text search follows
  the selected FTS tokenizer. `--instance` requires `--source`.
- Shared session filters are exact source kind/instance, effective source state,
  exact workspace, exclusive capture/source-observation bounds, and exact
  canonical session ID. `search` additionally accepts exclusive entry-timestamp
  bounds, actor, origin, exact entry kind, exact tool name, and exact tool
  namespace. A missing timestamp does not satisfy a time bound.
- Filters constrain the primary matching occurrence/entry. Context need not
  satisfy them. Tool-name and namespace filters select tool-call entries only,
  combine with AND when both appear, and never infer an invocation from text.
- Search groups qualifying occurrences by `(session identity, entry ordinal)`.
  The best-ranked segment, then lowest segment ordinal, supplies the primary
  snippet; expose the count of other matching segments without duplicating the
  hit. Page limits count primary hits only.
- Search defaults to 20 hits and allows 1–200. Context defaults to zero adjacent
  entries and allows 0–10 on each side. Independently include directly linked
  source-observed `tool-call`/`tool-result` pairs in either direction,
  non-recursively, deduplicated and ordinal-sorted; other uses of
  `relatedEntryOrdinal` do not qualify. Cap linked additions at 20 and report
  truncation. Render each snippet/context body to at most 512 UTF-8 bytes with
  explicit truncation.
- List keeps its 50-session default and 200 maximum. List and search expose an
  opaque next cursor only when more primary rows exist. `show` remains exact-ID
  transcript retrieval with its existing entry/context contract; “shared” means
  a filter has identical meaning wherever accepted, not that every command
  accepts every filter.
- Search support is query-wide and computed after all filters but before page
  slicing: matching text-segment occurrences, distinct collision-safe canonical
  content values, distinct resolved known roots, and distinct matching sessions
  whose root is unknown. Never substitute one count for another.
- M6 output is human-facing. M7 still owns versioned search/list/show JSON or
  JSONL DTOs, document digests, and portable export.

## Changes

1. `src/domain/session.ts`, `src/domain/session-validation.ts`, and
   `src/application/validate-session.ts` — add required provider-neutral
   `lineageCoverage: "complete" | "unknown"` evidence to each canonical
   document. Complete means the adapter can account for all immediate rootward
   relations; unknown means absence of a relation cannot prove a root. Preserve
   the value through immutable admission. Update generic fixture builders and
   adapter contracts so missing provider evidence stays unknown.

2. `src/adapters/codex/state-db.ts`, `src/adapters/codex/source.ts`,
   `src/adapters/codex/lineage.ts`, and `src/adapters/codex/normalize.ts` — retain
   an explicit frozen spawn-edge coverage value instead of collapsing table
   absence and row absence into the optional `parentId`. A missing optional
   `thread_spawn_edges` table yields unknown lineage coverage even when rollout
   metadata supplies a relation. A supported table with either one valid edge or
   an explicit row absence may yield complete coverage only after current rollout
   metadata passes the existing consistency checks. Pass this evidence through
   source read into normalization and keep the adapter free of root resolution or
   recurrence policy. Extend state/source/normalizer fixtures for table-absent
   unknown coverage, supported-table row absence, a valid edge, matching metadata,
   and conflicting metadata. Advance `CODEX_ADAPTER_VERSION` from `codex-v1` to
   `codex-v2`; this normalization-output change must trigger the existing
   adapter-version-aware re-read path rather than silently redefining V1.

3. Add `src/domain/session-query.ts` and `src/domain/session-lineage.ts` — define
   validated immutable filter, limit, context, cursor, hit, page, and support
   values plus a pure root resolver. Parent, fork, and continuation targets are
   rootward; child targets are outward. A complete session with no rootward edge
   resolves to itself. Unknown coverage/kind, a non-high-confidence rootward
   edge, a missing retained target, a cycle, or multiple ancestry paths that do
   not converge on one root resolves to unknown. Equal text/hash and inverse
   relation inference never create lineage. Use iterative visited-state logic,
   not unbounded recursion.

4. Add `src/application/ports/session-query.ts`, expose it beside `sessions` on
   the read-only `IndexReader` in `src/application/ports/index-lifecycle.ts`, and
   add `src/application/search-sessions.ts`. Define separate minimal results:
   list returns summaries and an optional next cursor; search returns primary
   hits, their context, query-wide support totals, and an optional next cursor.
   One port call returns each complete result from one immutable SQLite snapshot.
   Introduce typed query failures so malformed/query-mismatched cursors map to
   usage exit 2 while a cursor from another library/generation maps to a
   sanitized stale-cursor operational exit 1. Preserve causes without exposing
   SQL, paths, cursor payloads, or transcript text.

5. Refactor `src/application/list-sessions.ts` onto the query port and remove
   `SessionIndexReader.listSummaries` plus its SQLite forwarding implementation.
   Preserve the existing activity-descending/null-last/raw-identity ordering,
   50/200 bounds, and exact `No sessions found.\n` empty output. Replace the old
   `truncated` boolean and `… more sessions not shown` line with an optional
   `nextCursor` and copyable `Next cursor: <token>` line. An uninitialized library
   still returns empty success without creating state or resolving Codex. Search
   follows the same rule when no cursor is supplied; presenting a cursor against
   an absent/recreated library is stale. Keep `src/application/show-session.ts`
   on exact canonical reconstruction rather than adding irrelevant query filters.

6. Amend `src/infrastructure/sqlite/migrations/0001-bootstrap.ts` and canonical
   round-trip code under `src/infrastructure/sqlite/` for lineage coverage and a
   random, non-secret library instance ID. Retain the existing writer-lease
   generation as the conservative query-visible revision: every admitted writer
   may stale cursors, including a no-op writer, but no mutation may remain
   falsely fresh. The instance ID prevents an old cursor becoming valid after
   `data clear` and recreation. Add only indexes demonstrated by the checked-in
   query corpus or query-plan assertions.

7. Add `src/infrastructure/sqlite/sqlite-session-query.ts` and focused helpers
   for literal FTS translation and cursor encoding. Join FTS content through
   occurrences to entries/sessions; all values remain parameterized. Effective
   source state is unknown while source coverage is unknown, otherwise the
   tracking presence state. Effective source-observation time is the source
   coverage observation in the former case and the session presence observation
   in the latter; never substitute `lastSeenAt`.

   Rank each entry by its best content-level FTS5 BM25 value, then effective
   session activity descending with null last, raw source kind/instance/native
   identity using binary collation, and entry ordinal. Occurrence frequency must
   not improve relevance. Use offset continuation only because the cursor binds
   an immutable library generation and the full query/order version. Encode a
   bounded versioned base64url payload containing command, canonical query
   fingerprint, library instance ID, writer generation, and next offset; validate
   every decoded field before use.

8. In the same query repository operation, select bounded neighboring entries
   and the union of direct outbound/inbound `relatedEntryOrdinal` partners only
   when the pair is a source-observed `tool-call` and `tool-result`. Exclude turn
   start/terminal, lifecycle, and every other related-entry pairing from automatic
   linked context. Preserve canonical ordinals, relation IDs, and exact tool
   identity only on source-observed call entries. Return linked tool results with
   their relation but never copy call name/namespace onto them. Compute support
   totals over the unpaged filtered occurrence set, resolve roots with the pure
   domain policy, and count unknown lineage by distinct matching session.

9. Extract the FTS projection definition/rebuild logic under
   `src/infrastructure/sqlite/` so bootstrap and repair cannot drift. During an
   explicit leased `index` writer open, distinguish canonical corruption from
   FTS-only structure/content damage and rebuild only FTS tables/triggers from
   `sessions_content_values`; do not delete or re-read canonical sessions.
   Doctor remains read-only and continues to report `rebuild-required`. Do not
   add a public repair command.

10. `src/cli/program.ts`, `src/cli/render.ts`, `src/cli/run.ts`, and
    `src/bin/sessions.ts` — add `search`, shared option parsers, filtered/cursored
    list composition, terminal-safe evidence rendering, exact empty output,
    support totals, context/link truncation, and a copyable next cursor. Add the
    approved flags: `--source`, `--instance`, `--source-state`, `--workspace`,
    `--captured-after`, `--captured-before`, `--observed-after`,
    `--observed-before`, `--session`, `--limit`, and `--cursor`; search additionally
    accepts `--entry-after`, `--entry-before`, `--actor`, `--origin`, `--kind`,
    `--tool-name`, `--tool-namespace`, and `--context`. Search validates
    `--limit` from 1 through 200 with default 20; list retains the same flag with
    default 50 and maximum 200. Reuse one canonical timestamp parser and reject
    inverted/equal bounds before invoking services.

11. Add a checked-in generic corpus under `test/fixtures/` and a reusable query
    contract under `test/contracts/`. The corpus must include prose, Unicode,
    paths, symbols, opaque IDs, quotes/FTS keywords, punctuation-only input,
    multiple matching segments, exact duplicate content, deterministic rank
    ties, terminal controls, long content, missing timestamps, all source states,
    and linked/non-adjacent tool results. Lock `unicode61`, literal token-AND,
    BM25/tie ordering, the 20-hit default, and 512-byte truncation only through
    explicit assertions. Follow the Vitest guidance: reusable factories,
    isolated temporary state, awaited failure assertions, and no broad snapshots.

12. Extend domain, application, SQLite, CLI, and
    `test/application/codex-vertical-slice.sqlite.test.ts` coverage. Required
    matrices include filter combinations; exact workspace/tool fields; special
    FTS input; empty/tokenless success; deterministic repeat queries; page
    traversal without duplicates; invalid/query-mismatched/stale/recreated-library
    cursors; adjacent and non-adjacent linked context; mention/injected text versus
    observed call/result evidence; exclusion of linked turn/lifecycle entries;
    source deletion invariance and effective present/missing/unknown observation
    time; and lineage cases for within-session repetition, independent roots,
    parent/child, fork, continuation, missing ancestor, unknown coverage, low
    confidence, converging/diverging ancestry, and cycles. Corrupt FTS fixtures
    must prove explicit indexing repairs the projection while byte-for-byte
    canonical query rows remain unchanged. The Codex vertical slice must also
    prove a retained `codex-v1` observation is re-read under `codex-v2` and then
    becomes unchanged on the next index.

13. Reconcile `README.md`, `docs/reference/cli-contract.md`,
    `docs/reference/codex-format-support.md`, `docs/architecture-memo.md`,
    `docs/privacy.md`, `docs/contributing/architecture.md`, and the roadmap/index.
    Document exact flags, inclusive/exclusive behavior, effective observation
    time, rank/tie policy, cursor invalidation, hit/count units, lineage coverage,
    context and truncation, empty results, repair guidance, and M6-versus-M7
    boundaries. Advance the Codex reference from its M5/`codex-v1` contract to
    `codex-v2` and document table-absent unknown coverage versus supported-table
    row absence. Remove language describing search as planned only after its
    end-to-end path passes.

## Verify

- Run focused domain, query-contract, SQLite-query/repair, application, CLI, and
  Codex vertical-slice Vitest files in run mode while developing.
- Build the distribution and smoke `index -> search -> next cursor -> show`
  against a temporary application-data directory and generated synthetic Codex
  home; verify provider inputs are unchanged and output contains no workspace,
  source locator, or source metadata.
- Run `pnpm check`.
- Run the repository change-review workflow and resolve/re-review all accepted
  findings before opening the implementation PR.

## Boundaries

- No provider-specific branches in domain, application, SQLite query, or CLI
  code. No provider source reads during list/search/show.
- No semantic/vector search, FTS query language, heuristic workflow buckets,
  automation/subagent filtering, pattern recommendations, or skill-effectiveness
  policy. Packaged playbooks remain M9.
- No public adapter/plugin ABI, Cursor work, JSON/JSONL transcript/search DTOs,
  portable export, public repair command, daemon, or network dependency.
- No backward compatibility for pre-release M5 databases. Never delete or
  silently migrate them; fail closed and require a fresh Sessions data directory
  or explicit removal of only Sessions-owned state.
