# Contributor setup

## Requirements

- Node.js 24.16 or newer.
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

The current public CLI writes no user state. `sessions paths` resolves the platform-local `sessions` cache directory, or the exact absolute `SESSIONS_CACHE_DIR` override, without creating it. Tests exercise the internal indexing/reconciliation service, schema-v3 coordinated writer, canonical repository, clear maintenance, and immutable health inspection. Concrete adapters and public index/clear/query commands remain planned. Index paths, ownership, and deletion limits are governed by [privacy](../privacy.md).

That cache path is the pre-M5 implementation baseline. The accepted public
design moves durable canonical data to platform application data under
`SESSIONS_DATA_DIR`; it does not silently reuse or migrate the pre-public cache.
Its planned `.scratch` child is an ephemeral writer-leased discovery workspace,
not a second library or provider backup.

## Hooks

The pre-commit hook formats/lints staged files and runs the full typecheck. Bypass only when diagnosing hook behavior; always run `pnpm check` before handoff.

## Troubleshooting

- Wrong Node/pnpm: compare `node --version` and `pnpm --version` with `package.json`.
- Missing FTS5: run `pnpm build` then `node dist/bin/sessions.js doctor --format json`.
- Unexpected index path or state: run `node dist/bin/sessions.js paths --format json`; inspection does not repair or migrate it.
- Stale build: `pnpm clean && pnpm build`.
- Gate failure: rerun the focused script listed by the failed `pnpm check` step.

Setup never invents credentials or provider configuration. No environment file is required for the foundation.
