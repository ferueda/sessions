# Reuse lineage resolution across each query

## Goal

Remove repeated retained-lineage indexing from broad search support without
changing lineage semantics or public output. `countRootSupport` currently reads
the retained lineage once but calls `resolveSessionRoot` for every matching
session; each call rebuilds the full identity index and a fresh memo. A generic
2,000-session probe took about 949 ms and showed near-quadratic doubling.

The target creates one resolver for the immutable query snapshot, shares only
its finalized root memo, and keeps traversal-local cycle state per resolution.
Known/unknown counts, conservative ancestry rules, ordering, storage, adapters,
and CLI contracts remain unchanged.

## Changes

1. `src/domain/session-lineage.ts:createSessionRootResolver` — replace the
   one-shot public helper with a factory that indexes the retained evidence once
   and returns a root-resolution function. The resolver owns one shared memo of
   final known/unknown results; every unresolved start gets a fresh stack and
   visiting set. Memoize only completed frames so result order cannot affect
   cycles or divergent ancestry. Preserve duplicate-identity removal, absent
   starts/targets, unknown coverage/kinds, non-high rootward confidence, ignored
   child edges, convergent/divergent roots, frozen known results, and iterative
   deep ancestry. No compatibility wrapper is needed because the package exports
   no library API and the only production caller moves to the factory.

2. `src/infrastructure/sqlite/sqlite-query-lineage.ts:countRootSupport` — read
   retained evidence as today, construct exactly one resolver, and use it for all
   matching identities. Keep the resolver query-local; never cache it across
   reader snapshots or writer generations. Do not change SQL, support units, or
   error translation.

3. `test/domain/session-lineage.test.ts` and
   `test/infrastructure/sqlite-query-lineage.test.ts` — run the existing
   behavioral matrix through the factory. Add deterministic structural proofs
   that many resolutions iterate the retained corpus once, shared ancestors are
   traversed once after final memoization, forward/reverse resolution order has
   identical results, and repeated SQLite queries retain the exact current root
   counts. Keep deep ancestry iterative and cover duplicates, missing targets,
   convergence, divergence, and direct/indirect cycles without wall-clock
   assertions.

4. `scripts/measure-query-lineage.ts`, `package.json`, and
   `docs/contributing/commands.md` — add opt-in
   `pnpm measure:query-lineage` outside `pnpm check`. Over one deterministic
   generic in-memory corpus, compare rebuilding a resolver per start with one
   query-scoped resolver, assert exact result equality, and print only corpus
   size plus aggregate elapsed timings/speedup. Timings are diagnostic evidence,
   never a pass threshold; no transcript, identifier, path, database, or network
   input is used.

## Verify

- `pnpm test test/domain/session-lineage.test.ts test/infrastructure/sqlite-query-lineage.test.ts`
- `pnpm measure:query-lineage` and inspect the aggregate comparison; equality is
  the only correctness gate.
- `pnpm check`

## Boundaries

- No root attribution/filter, entry query, search mode, ranking, cursor, DTO,
  adapter, schema, or canonical-document change.
- No cross-query cache, persisted derived lineage state, recursive SQL, timing
  threshold, or private/live-library benchmark.
