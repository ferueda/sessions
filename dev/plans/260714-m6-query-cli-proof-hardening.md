# Harden M6 query and CLI shipping proofs

## Goal

Make the existing compiled and packed CLI smoke prove the complete Codex tool
evidence path—source record, canonical linkage, exact tool filters, and human
rendering—and make leading-dash search text unambiguous. Preserve current runtime
semantics: exact filters already work, `--` admits a leading-dash operand, and
unknown options remain usage errors.

This is one test/contract hardening change. It should not add a second smoke
harness or production query behavior unless the new proof exposes a defect.

## Changes

1. `scripts/smoke-m6-workflow.ts:runM6SmokeWorkflow` — extend the existing generic
   Codex rollout with one bare tool call/result pair, one namespaced tool
   call/result pair, and ordinary text that mentions the same search marker/tool
   names. Through `stableProviderCommand`, execute exact bare-name and
   name+namespace searches with `--context 0`. Assert each returns only its
   intended observed `tool-call`, excludes the other call and mention-only text,
   and renders the exact primary call ordinal plus bare or `namespace/name`
   identity. Assert an exact `Context (linked)` result heading whose
   `related=#<call ordinal>` points back to that primary call; do not require or
   invent reverse linkage on the call. Zero adjacent context must make this proof
   fail if automatic linked-partner expansion regresses. Keep the provider tree
   snapshot around every command.

   Add a spawned `search -- ---` assertion for exit `0` and the exact empty
   result, plus a delimiter-free leading-dash/unknown-option assertion for exit
   `2`. Because both `scripts/smoke-dist.ts` and `scripts/smoke-package.ts` call
   this shared workflow, do not duplicate either proof in those entrypoints.

2. `test/cli.test.ts:sessions CLI` — add the focused grammar regression: `--`
   passes the exact leading-dash string to the provider-neutral search handler,
   while the same token without the delimiter is rejected as an unknown option
   and does not call the handler. Keep empty results successful and unknown
   flags at exit `2`.

3. `README.md`, `docs/reference/cli-contract.md:Search text, filters, and hits`,
   and `docs/contributing/testing.md:Layers` — add the user-facing
   `sessions search -- "-term"` example and clarify that literal FTS semantics
   begin after CLI argument parsing. Preserve the separate normative rule that
   unknown flags fail. Update contributor testing guidance only enough to record
   that the shared dist/package Codex workflow now covers observed tool
   filters/linkage.

## Verify

- `pnpm exec vitest run test/cli.test.ts`
- `pnpm check`

## Boundaries

- Synthetic generic records and temporary roots only; no live/private provider
  data, local paths, IDs, or content in fixtures or assertions.
- Do not add `--text`, relax unknown-option parsing, change literal FTS/filter
  behavior, or create another distribution smoke workflow.
- Tool-name/namespace filters select source-observed canonical calls only; text
  mentions and injected catalogs must remain non-evidence.
