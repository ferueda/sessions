# Lineage

## Purpose

Lineage distinguishes repeated evidence from related sessions from evidence
across independent session roots. Sessions stores provider-observed relations
and resolves roots in provider-neutral domain code.

## Rules

1. Root resolution uses only retained identities, declared lineage coverage,
   relation kind, target, and confidence. Equal text, equal hashes, timestamps,
   and inferred inverse relations do not create lineage.
2. Coverage must be `complete`. With no rootward relation, the session is its
   own known root.
3. High-confidence `parent`, `fork`, and `continuation` relations point toward a
   root. `child` points outward and is ignored for root resolution.
4. Every rootward path must resolve to the same retained root. Converging paths
   are known; divergent paths are unknown.
5. Unknown coverage or relation kind, lower-confidence rootward evidence,
   missing targets, duplicate retained identities, and cycles resolve to
   unknown.

The resolver indexes one immutable retained-library snapshot, walks ancestry
iteratively, and reuses completed results within that resolver. This avoids call
stack limits and repeated work for shared ancestors.

## Query behavior and failures

Search calculates lineage support after all filters and before page slicing.
It reports distinct known roots and distinct matching sessions with unresolved
lineage as separate counts. Unknown lineage is never counted as an independent
root.

Malformed stored coverage, relations, confidence, or identities fail as
canonical corruption. Resolution otherwise stays conservative and returns
unknown instead of guessing.

## Cost and tradeoff

A non-empty search reads the retained lineage graph to calculate exact support,
then memoizes ancestry for that query. The work grows with retained lineage, not
just the result page. This cost preserves exact query-wide counts and avoids
unsafe independence claims.

## Code and proofs

- Root policy: `src/domain/session-lineage.ts`
- SQLite evidence and support counts:
  `src/infrastructure/sqlite/sqlite-query-lineage.ts`
- Query integration: `src/infrastructure/sqlite/sqlite-session-query.ts`
- Tests: `test/domain/session-lineage.test.ts`,
  `test/infrastructure/sqlite-query-lineage.test.ts`
