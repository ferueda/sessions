# Add digest-guarded coordinate reads

## Goal

Let callers hydrate a manifest-selected session only when the retained canonical
public document still has the expected digest. Add an optional guard to existing
`show` and `export` reads so a valid mismatch fails before entry bounds are
resolved or transcript evidence is returned. Existing unguarded behavior and
successful human, JSON, and JSONL output remain unchanged.

The guard is content-addressed rather than an archive or lease: identity and the
complete public-document digest must match, while current capture attribution,
freshness, source state, adapter version, and root resolution may differ. A
mismatch never retrieves an older body or automatically retries against the new
revision.

## Changes

1. `src/domain/public-session-document.ts` and `src/cli/program.ts` — admit one
   canonical lowercase SHA-256 digest value for the optional
   `--expected-document-digest` flag on both `show` and `export`. Convert it to
   the existing `SessionDocumentDigest` value with the fixed
   `sha256-sessions-document-jcs-v1` scheme before library inspection. Malformed
   input is usage failure with exit `2`; the flag is orthogonal to all current
   show/export selection modes.
2. `src/application/show-session.ts`, `src/application/export-session.ts`, and a
   focused shared application helper — accept an optional expected document
   digest, reuse the existing single fully verified `getSession` result, and
   compare the returned summary digest before resolving actual entry bounds or
   selecting presentation output. Missing identity remains `session-not-found`;
   a valid mismatch becomes a distinct `document-digest-mismatch` operational
   failure with exit `1`, empty stdout, and no expected or current digest in the
   diagnostic. Mismatch takes precedence over an out-of-document coordinate.
3. `src/application/library-error.ts` and the CLI composition in
   `src/bin/sessions.ts` — carry the guarded input through the provider-neutral
   application boundary and render the fixed sanitized mismatch message. Do not
   add a machine-readable error envelope or change successful schema-1 records.
4. Keep `SessionIndexReader.getSession` and the SQLite schema unchanged. The
   current `SqliteReadSnapshot` already returns one immutable operation or
   discards it on concurrent file change, while `getSession` reconstructs the
   complete canonical document and verifies stored/computed digests and metrics.
   This milestone preserves that proof and makes no cheaper-physical-read claim.
5. Update `docs/project-intent.md`, `docs/architecture-memo.md`,
   `docs/getting-started.md`, `docs/contributing/architecture.md`, `docs/privacy.md`,
   `docs/reference/cli-contract.md`, `docs/reference/structured-output.md`, and
   the packaged Sessions skill evidence protocol/search guidance to distinguish
   current guarded behavior from deferred historical storage and physical read
   optimization. Replace manual post-hydration digest comparison with the guard
   for manifest-driven reads.
6. Extend the digest parser, show/export application, CLI, one provider-neutral
   workflow integration, and packaged-skill contract test seams. Prove matching
   guarded output equals unguarded output; revision A fails after replacement by
   B with no stdout; B returns the exact requested entry/range; mismatch
   precedes coordinate absence; a valid guard on an absent identity remains
   `session-not-found`; attribution-only changes do not invalidate an equal
   document; and neither guarded command resolves a provider. Prove the guarded
   missing-session precedence once through a parameterized show/export
   application test rather than another integration layer. Rely on the
   existing SQLite digest-corruption/concurrent-snapshot tests and closed
   structured-output tests because those owners do not change.

## Verify

- Run focused digest parser, show/export application, CLI, provider-neutral
  workflow, and skill contract tests covering the changed surfaces.
- Run `pnpm check`.
- If compiled-entrypoint wiring is not already covered by the focused workflow,
  use an isolated generated library or the existing synthetic distribution smoke;
  routine proof must not depend on private provider or contributor library state.

## Boundaries

- Do not add a new read command, structured-output schema, storage migration,
  historical revision retention, manifest lease, batch hydration, or automatic
  retry/re-key behavior.
- Do not expose current or expected digests in mismatch diagnostics, reopen a
  provider, change presentation bounds, or weaken complete-document validation.
- A future partial-read optimization requires separate measurement and a design
  that preserves the complete canonical digest proof.
