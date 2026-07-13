# Contributing

Sessions is pre-alpha. Small vertical slices, explicit contracts, and evidence-backed changes are preferred over speculative framework work.

## Setup

Requirements: Node.js 24.15 or newer, Corepack, Git, and a platform supported by Node.js.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

The install configures a lightweight pre-commit hook. It formats/lints staged files and typechecks the repository; it does not replace `pnpm check`.

## Change flow

1. Read the [project intent](docs/project-intent.md) and [current architecture map](docs/contributing/architecture.md).
2. Keep provider-specific parsing behind the [adapter contract](docs/contributing/adapter-contract.md).
3. Add focused proof at the highest stable seam described in [testing](docs/contributing/testing.md).
4. Run scoped checks while iterating and `pnpm check` before handoff.
5. Update current-behavior docs with code. Keep future behavior visibly planned.

The [contributor index](docs/contributing/index.md) routes all engineering documentation. The [command inventory](docs/contributing/commands.md) identifies mutating and networked repository operations.

## Data safety

Never commit real transcripts, secrets, personal workspace paths, or fixtures copied from private histories. Minimize and synthesize reproductions. Report sensitive defects through the process in [SECURITY.md](SECURITY.md), not a public issue.
