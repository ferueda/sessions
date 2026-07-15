# Accept current Codex session metadata

## Goal

Capture valid current Codex threads whose `session_meta.session_id` is a
nonempty group identity shared by a root thread and its descendants, distinct
from `session_meta.id`. Keep `id` as the discovered thread identity, keep
explicit state/metadata edges as the only lineage evidence, and never project
the provider group ID into canonical documents.

Publish the corrected acceptance contract as `codex-v3`. Although never-captured
failures already retry, retaining `codex-v2` would make one adapter version name
two different parser contracts and violate controlled parser invalidation. The
first V3 index intentionally re-normalizes retained successes and captures newly
accepted stable candidates; the next stable index must skip them as unchanged.

## Changes

1. `src/adapters/codex/normalize.ts:CodexRolloutNormalizer.#sessionMeta` — continue
   requiring current metadata `id` to match the discovered native thread ID and
   continue validating optional `session_id` as nonempty text, but remove the
   equality requirement between those fields. Do not feed `session_id` into
   identity, parent/fork relations, entries, source metadata, or any canonical
   field. Preserve all current conflict checks for state edges,
   `parent_thread_id`, and `forked_from_id`.

2. `src/adapters/codex/source.ts:CODEX_ADAPTER_VERSION` — advance the normalization
   contract from `codex-v2` to `codex-v3`. Do not add a storage migration or
   compatibility branch: the existing freshness comparison must perform one
   controlled re-read and then stabilize on the unchanged V3 revision.

3. `test/adapters/codex/normalize.test.ts` — replace the obsolete mismatched-ID
   rejection with focused proofs that a distinct nonempty `session_id` is
   accepted, `document.identity` still uses `id`, explicit state/parent/fork
   lineage is unchanged, and the group marker is absent from serialized
   canonical output. Retain/add malformed cases for empty and non-string
   `session_id` without asserting private values in errors.

4. `test/fixtures/codex/source.ts`, `test/adapters/codex/source.test.ts`, and
   `test/application/codex-vertical-slice.sqlite.test.ts` — represent a generic
   current Codex child/thread fixture with distinct thread and group IDs plus an
   explicit parent edge. Prove adapter read and durable indexing succeed,
   canonical identity/lineage come only from thread/edge evidence, stored
   versions advance from an injected `codex-v2` observation to `codex-v3`, and a
   following unchanged index performs no rollout update. Keep provider-tree
   non-mutation and private-locator assertions intact.

5. `docs/reference/codex-format-support.md` and
   `docs/contributing/adapter-contract.md:Codex implementation` — declare
   `codex-v3`; define `id` as thread identity and optional `session_id` as an
   independently validated group identity shared by a root and descendants that
   may differ and is not projected or treated as direct lineage. Explain one
   controlled V2-to-V3 re-normalization followed by unchanged skips. Update only
   the shipped-version mention in
   `dev/plans/260713-v1-implementation-roadmap.md:Current state` if it would
   otherwise become stale; do not alter roadmap scope or sequencing.

## Verify

- `pnpm exec vitest run test/adapters/codex/normalize.test.ts test/adapters/codex/source.test.ts test/application/codex-vertical-slice.sqlite.test.ts`
- `pnpm check`
- After the writer-lease scalability change is present, run this local,
  uncommitted privacy wrapper. It captures two complete index reports in memory,
  preserves a nonzero CLI exit, and emits only aggregate-safe counts and failure
  kinds:

  ```bash
  node --input-type=module <<'NODE'
  import { spawnSync } from "node:child_process";
  const safeReports = [];
  for (const phase of ["renormalize", "stable"]) {
    const result = spawnSync(
      process.execPath,
      ["dist/bin/sessions.js", "index", "--source", "codex", "--format", "json"],
      { encoding: "utf8" },
    );
    if (result.error || result.status !== 0) process.exit(result.status ?? 1);
    const report = JSON.parse(result.stdout);
    const failureKinds = {};
    for (const source of report.sources) {
      for (const item of source.items) {
        if (item.outcome !== "failed") continue;
        failureKinds[item.failure] = (failureKinds[item.failure] ?? 0) + 1;
      }
    }
    safeReports.push({
      phase,
      counts: report.counts,
      incompleteSources: report.incompleteSources,
      allCoverageComplete: report.sources.every(
        (source) => source.coverage.status === "complete",
      ),
      failureKinds,
    });
  }
  process.stdout.write(`${JSON.stringify(safeReports)}\n`);
  NODE
  ```

  Require both phases to have `incompleteSources === 0` and complete coverage;
  the first must update retained candidates with no `malformed` failures, and
  the second must have `unchanged > 0`. The wrapper must emit no raw report,
  source/session identifiers, paths, or transcript content.

## Boundaries

- No raw `session_id` retention, canonical group field, inferred ancestry,
  domain/storage/query change, or permissive parsing of malformed values.
- Do not change source-change detection/retry or make provider-specific business
  policy leave the Codex adapter.
- Use only synthetic generic fixtures. Never commit or print local provider IDs,
  paths, databases, or transcript content.
