# Extend private capture staging to changed source reads

## Goal

Complete M11a by generalizing the writer-leased discovery workspace into one
opaque capture workspace that adapters may use during discovery and changed
candidate reads. The current engine exhausts discovery, checks repository
freshness, and only then calls `read(candidate)`. Cursor needs read-time staging
for WAL-backed stores; keeping staging discovery-only would require copying every
store before freshness can skip unchanged sessions.

The accepted direction and proof bar are in the
[V1 roadmap](260713-v1-implementation-roadmap.md#m11a--extend-private-capture-staging-to-changed-reads)
and [Cursor source survey](../../docs/research/cursor-source-survey.md). This is an
internal pre-release port correction. It must not change domain values, indexing
policy, durable storage, queries, export, CLI or structured output, Agent Skill
behavior, provider mutation rules, timing fields, or the package surface.

For this implementation, the user explicitly requires one final live smoke and
has authorized read-only access to real Codex history. The live proof supplements
the deterministic gate; it does not replace it or authorize provider mutation.

## Changes

1. `src/application/ports/session-source.ts:SourceDiscoveryWorkspace` and
   `src/application/ports/index-lifecycle.ts:IndexWriter` — replace the
   discovery-only name with `SourceCaptureWorkspace`, require the same opaque
   capability in both `discover(workspace)` and `read(candidate, workspace)`, and
   update the writer port type. Keep `probe()` workspace-free. Make this a clean
   internal cutover: remove the old names rather than adding aliases or optional
   parameters.

   Add an application-owned `SourceCaptureWorkspaceError` marker so application
   code can distinguish capability setup, cleanup, and lease failures without
   importing infrastructure. A callback-only adapter/source error must still
   escape unchanged. Any capability-owned failure, alone or combined with the
   callback error, must have the workspace marker at the top level and retain
   the original error or `AggregateError` as its cause.

2. Rename `src/infrastructure/state/source-discovery-workspace.ts` to
   `source-capture-workspace.ts` and rename its lifecycle, factory, error wording,
   and imports in `src/infrastructure/sqlite/database.ts`. Preserve the existing
   implementation semantics: open only after writer acquisition; canonical
   scratch root; random private attempts; POSIX hardening; symlink-safe cleanup;
   lease checks before allocation and after `finally`; no callback result before
   cleanup and final lease validation; busy-close refusal; scratch-root cleanup
   before heartbeat stop and lease release; and operation/cleanup/lease error
   preservation. The capability still exposes only
   `withPrivateDirectory(operation)`—no root, paths, lease identity, durable
   cache, adapter state, or new concurrency policy.

   Keep detailed internal failure codes used by writer/setup tests, but ensure
   every capability-owned failure thrown from `withPrivateDirectory` carries the
   application marker described above. Rename and retain the complete lifecycle
   suite in `test/infrastructure/source-capture-workspace.test.ts` and the writer
   cleanup regression in `test/infrastructure/sqlite-writer-cleanup.test.ts`.

3. `src/application/read-session-document.ts:readSessionDocument` /
   `readSessionReplacement`, `src/application/run-index.ts:applyCandidate`, and
   `src/application/discover-sessions.ts` — require and thread the capture
   workspace through the admitted read path. `runIndex` must pass the exact
   writer-owned object to primary changed reads and the single fresh-discovery
   retry. Preserve freshness-before-read: unchanged candidates call neither
   `read` nor read-time `withPrivateDirectory`; bounded discovery staging remains
   allowed. Keep read-time staging inside the existing
   `changedReadAndNormalize` timing phase.

   Preserve ordinary source-failure admission and sanitization. Rethrow
   `SourceCaptureWorkspaceError` as a fatal indexing operation so cleanup or
   lease loss is never reported as malformed provider data. No replacement may
   reach the repository until the workspace callback, attempt cleanup, and final
   lease check all succeed. Existing run finalization and writer-close aggregation
   remain responsible for preserving every later failure.

   Apply the same cut-through rule to discovery: `discoverSessions` must rethrow
   the workspace marker instead of collapsing it into incomplete coverage, while
   ordinary invalid/thrown adapter discovery still produces the existing
   incomplete result. Capability failure means the writer-owned execution
   environment is unsafe; it is not provider evidence.

4. `test/fixtures/discovery-workspace.ts`,
   `test/fixtures/indexing-source.ts`, and
   `test/contracts/session-source.contract.ts` — rename the shared fixture to a
   capture workspace, record discovery and read workspace use separately, and
   pass it to every direct read helper. Make the provider-neutral synthetic
   adapter stage one changed read through `withPrivateDirectory`; Codex accepts
   the required read argument but may ignore it.

   `src/adapters/codex/source.ts:discover` must rethrow
   `SourceCaptureWorkspaceError` unchanged before `mapAdapterError`; future
   adapters follow the same rule whenever they catch around workspace use.
   Update mechanical callers in Codex fixtures/tests without changing Codex
   normalization, snapshot discovery, fingerprints, or provider-tree behavior.

5. Strengthen only the stable behavioral seams:

   - `test/application/read-session-document.test.ts` proves exact workspace
     forwarding, candidate snapshot admission, callback-only error handling, and
     fatal workspace failure passthrough.
   - `test/application/discover-sessions.test.ts` proves a workspace marker stays
     fatal while ordinary adapter discovery failure remains incomplete;
     `test/adapters/codex/source.test.ts` proves Codex does not remap the marker.
   - `test/application/run-index.test.ts` proves the same writer workspace reaches
     discovery, primary changed reads, and fresh retries; unchanged candidates
     have zero reads and zero read-stage allocations.
   - `test/application/run-index.sqlite.test.ts` adds one mixed real-lifecycle
     proof: a changed candidate stages privately and commits only after cleanup,
     the following unchanged run creates no read attempt, and a later staged-read
     failure leaves the last-good document unchanged and no scratch residue.
   - Shared synthetic/Codex conformance and the existing Codex vertical slice
     remain identical apart from the required capability argument. Do not add
     duplicate CLI/query tests.

6. `scripts/measure-codex-indexing.ts` — extend the sole authorized live Codex
   measurement instead of adding another live harness. In the bounded-source
   wrapper, capture the workspace object for each seed/stable run and require
   every discovery invocation and changed read in that run to receive that same
   reference. Do not compare seed and stable workspace identities because each
   writer owns a separate capability.

   Couple the new proof to existing timing evidence: seed read-workspace calls
   must equal `changedReadAndNormalize.calls` and be at least the 120-candidate
   cohort size; a bounded source-change retry may make the count larger. The
   stable run must have zero read-workspace calls and zero
   `changedReadAndNormalize` calls. Codex may still ignore the read workspace;
   deterministic synthetic tests own actual private allocation, cleanup, and
   failure behavior until M11b.

   Emit only aggregate workspace-delivery and read-call evidence alongside the
   existing output. Preserve the exact cohort, selected-rollout byte equality,
   health, writer-clean, timing, private-root, signal cleanup, and
   provider-read-only gates. Generic stage failures must not include private
   values. Do not add live CLI queries: `pnpm check` already proves compiled and
   installed `doctor`, native-ID `list`, `entries`, `show`, search, and JSONL
   export through the shared synthetic smoke.

7. Reconcile current-versus-planned documentation in `README.md`,
   `docs/contributing/adapter-contract.md`,
   `docs/contributing/architecture.md`, `docs/contributing/setup.md`,
   `docs/contributing/testing.md`, `docs/architecture-memo.md`,
   `docs/research/cursor-source-survey.md`, this roadmap, and
   `dev/plans/README.md`. Mark M11a complete with its proof, make M11b the next
   item, describe the workspace as available to changed reads, and label the
   survey's discovery-only statement as the research-time baseline. Keep the
   user-required M11a live exit gate documented as explicit-authority,
   aggregate-only operational evidence outside routine CI. Remove this completed
   executor plan in the implementation PR; Git history remains its archive.

## Verify

- `pnpm test test/application/read-session-document.test.ts test/application/discover-sessions.test.ts test/application/run-index.test.ts test/application/run-index.sqlite.test.ts test/contracts/synthetic-session-source.test.ts test/adapters/codex/source.test.ts test/adapters/codex/source-contract.test.ts test/infrastructure/source-capture-workspace.test.ts test/application/codex-vertical-slice.sqlite.test.ts`
- `pnpm check`

## Live acceptance

Run the existing opt-in measurement only with explicit authority to read real
Codex history. That authority is granted for this implementation:

```bash
pnpm measure:indexing:codex -- --allow-provider-read
```

Run it once from the completed branch after the focused tests and `pnpm check`.
Record only its aggregate counts, correctness booleans, and phase timings in the
implementation handoff or PR notes; do not retain private values or the temporary
library.

The final run must prove all of the following in one temporary library:

- the seed index captures the fixed cohort completely, every changed read gets
  the exact run-owned workspace, and workspace-read calls agree with timing
  calls;
- the second index is fully unchanged with zero reads, complete coverage, the
  same selected observations, and byte-identical selected rollout files;
- the library is healthy, the writer lease is free, the clean-writer proof is
  valid, and existing stable timing budgets still pass;
- provider snapshots stay unchanged through the complete journey and the exact
  mode-0700 temporary root is removed; and
- the preceding `pnpm check` passes the unchanged compiled and installed CLI
  journey, including doctor, native-ID lookup, entries, search, show, and JSONL
  export.

If the run fails only because the selected Codex cohort changed during capture,
wait for a quiet period and retry once. Do not retry other failures, loosen the
admission criteria, expose private command output, or use the ordinary Sessions
library. Report the failed stage if the second attempt does not pass.

## Boundaries

- No Cursor adapter, Cursor format reader, provider-specific branch, durable
  adapter cache, eager all-candidate capture, or discovery-policy change.
- No optional workspace argument, compatibility alias, public plugin ABI, new
  timing phase, CLI diagnostic, schema migration, or public contract change.
- No second live harness, live CLI query, raw transcript assertion, provider
  mutation, or ordinary Sessions-library access. The live check validates real
  indexing composition; deterministic tests remain the authority for staged-read
  failure and cleanup edges, and existing synthetic distribution smokes remain
  the authority for public CLI behavior.
- Stop and return to planning if changed-read staging requires paths, lease
  details, storage handles, persistence, or source-specific behavior outside the
  opaque application capability.
