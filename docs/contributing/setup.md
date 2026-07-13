# Contributor setup

## Requirements

- Node.js 24.15 or newer.
- Corepack with pnpm 11.10.
- Git.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

`.npmrc` rejects unsupported Node versions and records exact dependency versions. `pnpm-workspace.yaml` permits only the development hook package's install build.

## Generated repository state

| Path                                | Owner                         | Mutability                            |
| ----------------------------------- | ----------------------------- | ------------------------------------- |
| `node_modules/`                     | pnpm                          | Recreated by install; ignored         |
| `dist/`                             | TypeScript build              | Recreated by build; ignored           |
| `.git/hooks/`                       | simple-git-hooks              | Prepared on install; local Git state  |
| `.harness/`                         | Optional local review tooling | Rebuildable review artifacts; ignored |
| Temporary package-smoke directories | `scripts/smoke-package.ts`    | Removed after each run                |

The current CLI writes no user state. Future index paths and ownership are governed by [privacy](../privacy.md) and must ship with `sessions paths` plus explicit clear behavior.

## Hooks

The pre-commit hook formats/lints staged files and runs the full typecheck. Bypass only when diagnosing hook behavior; always run `pnpm check` before handoff.

## Troubleshooting

- Wrong Node/pnpm: compare `node --version` and `pnpm --version` with `package.json`.
- Missing FTS5: run `pnpm build` then `node dist/bin/sessions.js doctor --format json`.
- Stale build: `pnpm clean && pnpm build`.
- Gate failure: rerun the focused script listed by the failed `pnpm check` step.

Setup never invents credentials or provider configuration. No environment file is required for the foundation.
