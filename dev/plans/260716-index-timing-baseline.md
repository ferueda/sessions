# Measure routine indexing before optimizing it

## Goal

Add disabled-by-default, privacy-safe phase timing to the real indexing path and
use it to establish the M10 stable-run baseline. A stable run currently avoids
provider transcript reads but still performs library-wide writer validation,
full source discovery, one freshness read per candidate, and one immediate
transaction per unchanged candidate. This plan measures those owners without
changing indexing policy, reports, storage, or normal CLI output; the measured
dominant phase will define a separate optimization plan.

## Changes

1. `src/application/run-index.ts` and a focused application timing type/helper
   — add an optional monotonic timing recorder with a closed phase allowlist for
   writer open, source probe/discovery, freshness reads, unchanged writes,
   changed read plus adapter normalization/application admission, canonical/FTS
   replacement, reconciliation, run bookkeeping, and writer close. Time the
   existing calls in place, including retry discovery, and record durations in
   `finally`. When no recorder is supplied, invoke the current path directly.
   Clock or recorder failures are best-effort diagnostics and must never skip,
   repeat, mask, or replace an indexing operation or its error. Keep semantic
   timestamps on the existing `IndexClock`; use a separate monotonic clock only
   for elapsed time.

2. `src/infrastructure/runtime/index-timings.ts` and `src/bin/sessions.ts` —
   implement one in-memory aggregate collector and enable it only when
   `SESSIONS_INDEX_TIMINGS=1` is present for `sessions index`. Measure source
   resolution and total indexing around the instrumented application call, then
   emit one prefixed JSON line to stderr in `finally`. Admit and serialize only
   fixed phase keys, finite non-negative elapsed milliseconds, and aggregate
   call counts; never include source kinds, identities, paths, timestamps,
   fingerprints, errors, transcript data, or lease values. Emission is
   best-effort. Do not add a CLI flag, change help, add fields to `IndexReport`,
   persist timings, or affect stdout/exit behavior. With the environment switch
   absent, do not create a collector or call the monotonic clock.

3. `test/application/run-index.test.ts`, a focused collector test, and the
   existing compiled/package smoke seam — use deterministic clocks to prove
   phase totals/call counts for stable, changed, retry-discovery, missing, and
   failure/close paths. Prove a throwing clock/recorder cannot change the report
   or error. Exercise the built CLI once with the switch enabled against the
   generated Codex fixture: stdout remains the exact index JSON result, stderr
   adds exactly one aggregate timing record, and fixed private markers are
   absent. Retain the existing no-switch stdout/stderr assertions unchanged so
   normal behavior stays byte-for-byte stable.

4. `scripts/measure-indexing.ts`, `package.json`, and
   `docs/contributing/commands.md` — add an opt-in `pnpm measure:indexing`
   baseline outside `pnpm check`. Seed one deterministic, generic, file-backed
   2,000-session corpus through production `runIndex` and SQLite lifecycle
   seams, clone the clean seeded library into control and timed cases, and run
   both with the same source generation and semantic clock. Require the control
   and timed post-run states to have exact index reports, canonical/session rows,
   tracking/index-run rows, document digests, health, and representative paged
   list/search/entries results including support and lineage. Only comparisons
   from the seeded pre-run state to either stable post-run state may contain the
   documented unchanged outcome and observation-time transitions; last-good
   revisions, failure state, capture time, and canonical content remain exact.
   Require zero provider reads during both stable runs. Print only corpus counts,
   equality booleans, and aggregate phase timings; clean private temporary state
   in `finally`. Elapsed time is report-only until this baseline identifies the
   dominant phase.

5. `scripts/measure-codex-indexing.ts` and `package.json` — own the executable,
   contributor-only live protocol behind an exact `--allow-provider-read`
   acknowledgement. Fail closed before provider resolution on non-POSIX
   platforms; this optional diagnostic does not change the product's Windows
   support. On macOS/Linux, create and verify one mode-`0700` temporary root with
   a fresh `SESSIONS_DATA_DIR`. Use `createCodexSource` directly against the real
   read-only provider and wrap only its source port: each discovery still
   exhausts the complete production adapter generation, then yields the first
   120 candidates in binary native-ID order; probe and read delegate unchanged.
   Do not rebuild state, copy rollouts, inspect credentials, or add another Codex
   parser/path policy.

   Before any source operation and after both runs, hash a sorted no-follow
   snapshot limited to the resolved state database/WAL and rollout roots; keep
   paths and hashes in memory and discard the run on any difference. Run one
   unprofiled seed capture and one profiled stable capture against only the
   disposable Sessions library. Discard the measurement unless both have
   complete coverage and the profiled run has `discovered === unchanged`, zero
   updated/failed/missing/stale counts, and zero changed-read calls. Emit only
   allowlisted cohort count/source bytes, equality booleans, and aggregate
   timings; never emit paths, IDs, metadata, hashes, or transcript text. Remove
   the exact owned temporary root in `finally` and INT/TERM cleanup, while
   documenting that uncatchable process or machine failure can leave private
   temporary residue. The ordinary Sessions library is never opened or mutated,
   and the provider remains production-adapter read-only.

6. `docs/contributing/indexing.md`, `docs/contributing/testing.md`,
   `docs/contributing/commands.md`, `docs/reference/cli-contract.md`,
   `docs/architecture-memo.md`, and
   `dev/plans/260713-v1-implementation-roadmap.md` — document the contributor
   diagnostic, its privacy/output boundary, the private-mirror live command and
   stop conditions, and the honest combined changed-read/adapter-normalization
   phase imposed by the current source port. After the synthetic and authorized
   real baselines pass, record only the phase totals needed to identify the
   dominant owner and set the numeric budget in a separate reviewed optimization
   plan. Do not turn machine-specific timings into a public performance
   guarantee.

## Verify

- `pnpm test test/application/run-index.test.ts test/application/run-index.sqlite.test.ts test/application/codex-vertical-slice.sqlite.test.ts <focused timing tests>`
- `pnpm build && pnpm smoke:dist && pnpm smoke:package`
- `pnpm measure:indexing`; inspect only aggregate output and confirm its semantic
  equivalence assertions pass.
- With explicit live-data authority on macOS/Linux, run
  `pnpm measure:indexing:codex -- --allow-provider-read`. Accept only its
  disposable-library stable-run stop conditions, retain only aggregate evidence,
  and verify cleanup plus unchanged provider bytes.
- `pnpm check`

## Boundaries

- No batching, bulk repository port, cached cleanliness marker, skipped or
  weaker validation, provider-specific core branch, parallel writer, daemon,
  spinner, or progress contract in this change.
- No timing data in stable JSON/JSONL DTOs, durable SQLite state, telemetry,
  stdout, or normal stderr.
- Stop after the baseline if it does not identify a dominant owner; do not pick
  an optimization from the current hypotheses alone.
