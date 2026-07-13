# AGENTS.md

Work style: concise, evidence-backed, root-cause first.

## Protocol

- Verify behavior in code; do not guess.
- Add regression tests for bugs when the behavior has a stable seam.
- Keep files focused. Extract helpers when it improves clarity or testability.
- Add brief comments only for non-obvious logic.
- Preserve unrelated worktree changes.

## Repository invariants

- Sessions is standalone and local-first.
- Provider histories are read-only. Core operation has no telemetry or network dependency.
- Domain, application, storage, and query behavior stay provider-neutral.
- Adapters implement application ports; they do not own persistence, querying, or presentation.
- Only `src/bin/` composes concrete adapters and infrastructure.
- Current behavior and planned behavior must be labeled separately.
- Docs, examples, fixtures, and tests use generic data—never private downstream paths or transcripts.

## Source map

- Product intent: `docs/project-intent.md`
- Accepted target design: `docs/architecture-memo.md`
- Current code map: `docs/contributing/architecture.md`
- Privacy contract: `docs/privacy.md`
- CLI contract: `docs/reference/cli-contract.md`
- Contributor index: `docs/contributing/index.md`
- Active plans: `dev/plans/README.md`

## Verification

- Scoped: `pnpm test`, `pnpm typecheck`, `pnpm deps:check`, or another focused script.
- Definition of done: `pnpm check`.
- Hooks are fast feedback, not the final gate.

## Commits

- Review `git diff` before committing.
- Keep commits atomic and use short conventional messages: `feat:`, `fix:`, `docs:`, `test:`, `build:`, `ci:`, `chore:`, or `refactor:`.
