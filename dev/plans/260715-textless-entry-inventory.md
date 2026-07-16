# Add a textless retained-entry inventory

## Goal

Add a provider-neutral, index-only `sessions entries` query so users and agents
can enumerate structural evidence without guessing transcript search terms or
opening every retained document. The command reuses the shared session filters
and exact entry filters, defaults to `--select all`, returns 50 records by
default with a maximum of 200, and supports stable opaque pagination plus human,
JSON, and JSONL output.

`all` returns every qualifying entry. `first` and `last` return the minimum or
maximum canonical entry ordinal per session after every filter is applied; they
never use entry timestamps. Entries with no text remain eligible. Each compact
record includes the retained session summary, entry coordinate and tool/linkage
fields, one bounded representative text preview when available, exact text and
omission counts, and explicit known/unknown root attribution. Root attribution
is query-derived only: it does not enter canonical documents, document digests,
exports, ordering, or filters.

Use this public grammar:

```text
sessions entries [shared session filters]
                 [--entry-after TIMESTAMP] [--entry-before TIMESTAMP]
                 [--actor ACTOR] [--origin ORIGIN] [--kind KIND]
                 [--tool-name NAME] [--tool-namespace NAMESPACE]
                 [--select all|first|last]
                 [--limit N] [--cursor TOKEN]
                 [--format human|json|jsonl]
```

Order every mode by binary source kind, source instance, native ID, then entry
ordinal ascending. This is stable across equivalent reindexes, keeps a session's
entries together, and uses the existing source/tracking/entry keys without a
global activity sort. Do not add a schema migration or durable index in this
change; directional 200,000-entry evidence found no benefit that earns either.

## Changes

1. `src/domain/session-query.ts`, `src/application/ports/session-query.ts`, and
   `src/application/list-session-entries.ts` — add the immutable entry filter,
   `all | first | last` selection, query/page/result values, and
   `SessionQueryRepository.entries`. Share the existing entry filter fields with
   search rather than copying their validation. Defaults are `all` and 50;
   limits remain 1..200, time bounds stay exclusive, tool filters imply
   `tool-call`, and a cursor binds normalized selection, limit, and every filter.
   The application service follows list/search lifecycle semantics: a cursor-free
   absent library is an empty frozen success, an absent library plus cursor is
   stale, unavailable state is operational failure, and one immutable reader
   performs only `reader.query.entries`. Reuse the current 512-byte UTF-8 query
   preview bound.

2. `src/infrastructure/sqlite/query-cursor.ts`,
   `src/infrastructure/sqlite/sqlite-query-filters.ts`,
   `src/infrastructure/sqlite/sqlite-query-lineage.ts`,
   `src/infrastructure/sqlite/sqlite-session-query.ts`, and a focused new
   `src/infrastructure/sqlite/sqlite-session-entry-query.ts` — implement the
   repository query without FTS or canonical document reconstruction. Extend the
   cursor command union with `entries`; keep the current offset, library identity,
   and writer-generation payload and existing usage-versus-stale error mapping.
   Drive coordinate selection through source -> tracking -> canonical -> entries
   in the fixed binary-identity/ordinal order and fetch `limit + 1` rows. `all`
   selects direct qualifying rows; `first`/`last` use one per-session correlated
   ordinal lookup after all filters, avoiding a whole-corpus window sort.

   Entry time, actor, kind, and tool predicates are entry-level. Origin is
   segment-level: qualify through `EXISTS` on canonical occurrences so an
   omitted-only entry can match while an empty entry cannot. Without an origin
   filter, preview the lowest-ordinal text segment; with one, preview the
   lowest-ordinal text segment with that origin. If only omitted content matches,
   return the entry without a preview rather than displaying unrelated text.

   Hydrate content only for the selected page. Return exact text-segment and
   omitted-segment counts, derive the unpreviewed text count, and load at most one
   full preview candidate per entry. Validate its ordinal, origin/confidence,
   stored digest, and exact text hash before truncating at a Unicode boundary.
   Reuse `entryAt` and the current summary reader for stored invariants. Never
   select source locators, source metadata, workspace, provider paths, or omitted
   payloads. Extract one retained-lineage resolver constructor from
   `sqlite-query-lineage.ts`; build it once per nonempty immutable query call and
   memoize resolutions for distinct page sessions. Preserve the existing
   complete/unknown, confidence, missing-target, cycle, and convergent-root rules.

3. `src/cli/program.ts`, `src/cli/render.ts`, and `src/bin/sessions.ts` — add the
   command, compose it without resolving an adapter, and share session/entry
   option admission with search. Human output prints an escaped session/entry
   heading, known root or `unknown`, the preview or `(no text preview)`, exact
   content counts, and the next cursor. Empty human output is
   `No entries found.`; malformed filters/cursors are usage exit 2, operational
   state/cursor failures are exit 1, and empty success is exit 0.

4. `src/cli/structured-output.ts`, `src/cli/encode-json-output.ts`, and
   `src/cli/encode-jsonl-output.ts` — extend schema 1 with a new closed `entries`
   command family without changing existing list/search/show/export records. The
   fixed entry item contains `PublicSessionSummaryV1`, the existing entry
   coordinate, a root union of `{ kind: "known", session: SessionRefV1 }` or
   `{ kind: "unknown" }`, and content facts:

   ```ts
   {
     textSegmentCount: number;
     omittedSegmentCount: number;
     unpreviewedTextSegmentCount: number;
     preview?: {
       segmentOrdinal: number;
       origin: ContentOriginV1;
       originConfidence: ConfidenceV1;
       excerpt: SearchExcerptV1;
       contentHash: ContentHashV1;
     };
   }
   ```

   JSON emits one `page` object with nullable `nextCursor` and ordered `entries`.
   JSONL emits one page record with `entryCount` followed by independently
   attributable entry records. Empty JSONL still emits its page record. Preserve
   recursive freezing/closed-key validation, `untrusted-history`, atomic encoding,
   and the existing 16 MiB fail-before-stdout limit.

5. `test/fixtures/session-query-corpus.ts`,
   `test/contracts/session-query.contract.ts`,
   `test/infrastructure/sqlite-session-query.contract.test.ts`,
   `test/infrastructure/sqlite-session-entry-query.test.ts`,
   `test/infrastructure/sqlite-query-primitives.test.ts`,
   `test/infrastructure/sqlite-query-lineage.test.ts`,
   `test/domain/session-query.test.ts`, and
   `test/application/list-session-entries.test.ts` — prove the contract through
   stable domain, application, repository, and SQLite seams. The generic corpus
   must include injected/system content before direct human work, multiple human
   messages ending in a correction, an observed namespaced tool call/result, an
   ordinary tool mention, empty and omitted-only entries, roots plus retained
   child/continuation sessions, an independent root, and unknown/cyclic/missing
   lineage. Cover every shared/entry filter; origin before selection; first/last
   after filters; binary ordering; 50/200 bounds; multi-page traversal without
   duplicates; wrong-query and stale cursors; preview selection/truncation/hash;
   exact counts; known/unknown roots; repeatability; corruption; and private-field
   exclusion.

6. `test/cli.test.ts`, `test/cli-render.test.ts`,
   `test/cli-structured-output.test.ts`, `test/docs-contracts.test.ts`,
   `test/list-no-provider-resolution.test.ts`, and
   `scripts/smoke-workflow.ts` — protect exact CLI grammar, forwarding, streams,
   exits, human escaping, JSON/JSONL equivalence and line order, output-size
   failure, empty-library no-create behavior, and provider non-resolution. Extend
   the one shared compiled/package smoke with a namespaced tool-call `entries`
   JSONL query; assert its exact ordinal/tool/linkage, known self-root, one page +
   one item, unchanged document attribution, mention-only exclusion, provider-tree
   immutability, and absence of private fixture markers.

7. `scripts/measure-entry-query.ts`, `package.json`, and
   `docs/contributing/commands.md` — add opt-in `pnpm measure:entry-query` outside
   `pnpm check`. Seed a deterministic generic in-memory library through the
   production index seam with exactly 2,000 sessions and five entries per
   session, covering human first/last, tool evidence, and omitted-only content.
   Run broad `all`, filtered `first`, filtered `last`, and tool queries twice;
   require exact repeated records, order, roots, counts, previews, and cursors.
   Report only aggregate corpus sizes and elapsed times; timing is report-only.
   Keep the baseline schema unchanged and treat any later index as a separate
   measured optimization with explicit retained-size cost.

8. `README.md`, `docs/architecture-memo.md`, `docs/privacy.md`,
   `docs/reference/cli-contract.md`, `docs/reference/structured-output.md`,
   `docs/contributing/architecture.md`, new `docs/contributing/entries.md`,
   `docs/contributing/index.md`, and `docs/contributing/testing.md` — move
   `entries` from planned to current and document its exact filters, selection,
   ordering, preview/origin behavior, root semantics, cursor/empty/error contract,
   privacy boundary, cost, and agent cursor-loop examples. Keep literal-any,
   list/search root attribution, activity bounds, Cursor, and Markdown clearly
   planned. On completion, remove this plan, mark M8 item 4 complete and item 5
   next in `dev/plans/260713-v1-implementation-roadmap.md`, and reconcile
   `dev/plans/README.md`.

## Verify

- `pnpm test test/domain/session-query.test.ts test/application/list-session-entries.test.ts test/infrastructure/sqlite-session-query.contract.test.ts test/infrastructure/sqlite-session-entry-query.test.ts test/infrastructure/sqlite-query-primitives.test.ts test/infrastructure/sqlite-query-lineage.test.ts test/cli.test.ts test/cli-render.test.ts test/cli-structured-output.test.ts test/list-no-provider-resolution.test.ts test/docs-contracts.test.ts`
- `pnpm measure:entry-query` and inspect aggregate timings only after its exact
  correctness/repeatability assertions pass.
- `pnpm check`

## Boundaries

- No adapter, provider read, FTS query, canonical document reconstruction,
  schema migration, durable index, document-digest, export, or storage lifecycle
  change.
- No existing list/search/show/export DTO or cursor change; schema 1 gains only
  the new command/record family. Do not add root fields to list/search in this
  change.
- No literal-any search, activity-bound filter, root filter, semantic/workflow
  classification, automatic skill recommendation, or unbounded transcript text.
- Do not replace the existing offset cursor or add an index without new measured
  evidence and a separately accepted design.
