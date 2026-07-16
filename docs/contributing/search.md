# Search

The public behavior is defined by the [CLI contract](../reference/cli-contract.md#search-text-filters-and-hits).

## Search flow

1. The domain layer validates and freezes the text, exact filters, exclusive time
   bounds, page limit, context limit, and optional cursor. Blank or malformed
   values fail before SQLite runs.
2. SQLite splits the text on Unicode whitespace, quotes each term as literal FTS5
   data, and joins the terms with `AND`. User text is never treated as FTS syntax.
3. Exact filters restrict matching occurrences and entries. Matching segments
   group by session and entry, so one entry produces one primary hit.
4. SQLite ranks each entry by its best FTS5 BM25 score. Ties use session activity,
   source identity, and entry ordinal in a fixed order. The query keeps one extra
   rank row only to decide whether a next page exists.
5. After selecting the page, SQLite loads full text, its digest, and the FTS
   snippet only for the selected content IDs.
6. Search verifies each selected content hash, bounds snippets and context to 512
   UTF-8 bytes, and adds requested neighboring entries plus direct tool-call and
   tool-result links.
7. Support is calculated over the complete filtered result, before page slicing:
   matching occurrences, distinct content, known roots, and sessions with unknown
   lineage.
8. A next cursor binds the full query, library identity, writer generation, and
   offset. It is a continuation token, not a durable bookmark.

## Guarantees and failures

- Ranking, filters, grouping, support, snippets, context, and cursors are exact and
  deterministic for one retained snapshot.
- Repeated copies of one segment do not improve BM25 rank. They still count as
  occurrences, while distinct content and lineage use their own support units.
- Context does not inherit the primary hit's filters. Linked expansion is direct,
  bounded, deduplicated, and non-recursive.
- A cursor fails when its query differs or the library has changed. Malformed and
  query-mismatched cursors are usage errors; stale cursors are operational errors.
- Missing selected content, FTS disagreement, invalid stored values, or a content
  hash mismatch fails the read as corrupt data. Search never returns a partial hit
  as if it were valid.

## Cost

Rank-first hydration avoids loading large text, digests, and snippets for every
match when only one page is returned. Exact matching, ranking, query-wide support,
and lineage counts still inspect the full qualifying result, so broad searches can
still take longer on large libraries. The design favors exact evidence over
approximate counts or ranking.

## Code and proof

- Admission and result types: `src/domain/session-query.ts` and
  `src/application/search-sessions.ts`
- Matching and filters: `src/infrastructure/sqlite/literal-fts-query.ts` and
  `src/infrastructure/sqlite/sqlite-query-filters.ts`
- Ranking, hydration, support, and cursor use:
  `src/infrastructure/sqlite/sqlite-session-query.ts`
- Context and cursor encoding: `src/infrastructure/sqlite/sqlite-query-context.ts`
  and `src/infrastructure/sqlite/query-cursor.ts`
- Contract and regressions: `test/contracts/session-query.contract.ts`,
  `test/infrastructure/sqlite-session-query.contract.test.ts`, and
  `test/infrastructure/sqlite-session-query.test.ts`
- Repeatable measurement: `pnpm measure:search-query`
