# Add bounded show and export entry ranges

## Goal

Let users and agents retrieve one exact contiguous span from a retained session
without exporting the full transcript. Add inclusive `--from-entry` and
`--to-entry` options to `show` and `export`. Both options are required together,
the span may contain at most 200 entries, and out-of-document ranges fail rather
than silently returning less evidence.

Existing defaults remain unchanged. Ranged show cannot combine with
`--entry`/`--context`; ranged export cannot combine with `--full`. Ranges use the
existing bounded presentation rules, public projection, complete-document
digest, structured schemas, and encoded-output limit. This is bounded evidence
selection, not a range-aware SQLite read optimization.

## Changes

1. `src/application/session-entry-range.ts` — own the shared range contract.
   Validate the all-or-none inclusive endpoints before library inspection:
   non-negative safe integers, `fromEntry <= toEntry`, and
   `toEntry - fromEntry < 200`. Freeze the admitted value. After one retained
   document is read, convert it to the selector's half-open `{ start, end }`
   window; either endpoint outside the document raises the existing
   `entry-not-found` operational error. Avoid inclusive-end arithmetic until the
   stored length proves `toEntry + 1` safe.

2. `src/application/show-session.ts:showSession` and
   `src/application/export-session.ts:exportSession` — add `fromEntry` and
   `toEntry` inputs and use the shared range owner before calling
   `selectSessionTranscript`. Keep show focus/context and both command defaults
   unchanged. Reject show focus/context plus range and export full plus range
   before inspecting or opening the library. Ranged export always remains
   `bounded`; both commands still reconstruct one complete canonical document
   from one immutable reader before selecting the range.

3. `src/cli/program.ts`, `src/bin/sessions.ts`, and `test/cli.test.ts` — expose
   both non-negative integer options, forward them provider-neutrally, and map
   incomplete, reversed, oversized, or conflicting combinations to usage exit
   `2` before invoking the application handler. Preserve output formats and
   structured schema 1. Prove exact forwarding for both commands and unchanged
   existing show/export calls.

4. `test/application/session-entry-range.test.ts`,
   `test/application/show-session.test.ts`, and
   `test/application/export-session.test.ts` — cover endpoint inclusion, the
   200-entry boundary, a single-entry range with equal endpoints, range failure
   with `entry-not-found` against an empty document, all invalid combinations
   before inspection, exact out-of-document failure, default/focused/full
   compatibility, frozen values, one immutable read, selection counts/first/last
   ordinals, and unchanged complete-document attribution.

5. `scripts/smoke-workflow.ts`, `README.md`, `docs/architecture-memo.md`,
   `docs/reference/cli-contract.md`, `docs/reference/structured-output.md`,
   `docs/contributing/architecture.md`, and `docs/contributing/search.md` — add
   one compiled/package ranged retrieval proof and document the exact grammar,
   bounds, conflicts, failure behavior, selected-entry versus truncated-content
   distinction, full-document digest, and full-read tradeoff. Move bounded ranges
   from planned to current in the architecture memo, including both command
   signatures, and update generated command inventories only for shipped
   behavior.

6. `dev/plans/260713-v1-implementation-roadmap.md` and `dev/plans/README.md` —
   mark bounded show/export ranges complete, remove this executor plan, and make
   the textless `sessions entries` inventory the next M8 work.

## Verify

- `pnpm test test/application/session-entry-range.test.ts test/application/show-session.test.ts test/application/export-session.test.ts test/application/session-presentation.test.ts test/cli.test.ts`
- `pnpm check`

## Boundaries

- No structured-output schema version, document digest, default selection,
  storage/query repository, cursor, adapter, provider-read, or canonical schema
  change.
- No cursor or automatic range continuation. No silent clamping, open-ended
  range, `--full` range, or claim that range selection avoids full canonical
  reconstruction.
