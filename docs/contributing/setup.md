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

`sessions index` is the only ordinary command that initializes user state.
The library lives in platform application data, or the exact absolute
`SESSIONS_DATA_DIR` override. Its
`.scratch` child is an ephemeral writer-leased capture workspace, not a second
library or provider backup. The opaque capture workspace is available only while
an adapter discovers or reads a changed candidate; unchanged candidates do not
receive read-time staging. Sessions never reuses or migrates the pre-public
cache. Paths, ownership, capture behavior, and deletion limits are governed by
[privacy](../privacy.md).

Pre-alpha builds recognize only the current storage baseline. When that baseline
changes, use a fresh `SESSIONS_DATA_DIR` or manually remove the old Sessions-owned
directory and index again; provider data is never part of that cleanup. Ordered,
data-preserving forward migrations become supported after the first release.

The current Codex adapter resolves the default local installation. Tests use only
generated state databases and plain/Zstandard rollouts under temporary roots; no
developer provider history is a test dependency.

## Hooks

The pre-commit hook formats/lints staged files and runs the full typecheck. Bypass only when diagnosing hook behavior; always run `pnpm check` before handoff.

## Troubleshooting

- Wrong Node/pnpm: compare `node --version` and `pnpm --version` with `package.json`.
- Missing FTS5: run `pnpm build` then `node dist/bin/sessions.js doctor --format json`.
- Unexpected library or source path/state: run
  `node dist/bin/sessions.js paths --format json`; inspection does not repair,
  migrate, or read transcript content.
- Stale build: `pnpm clean && pnpm build`.
- Gate failure: rerun the focused script listed by the failed `pnpm check` step.

Setup never invents credentials or provider configuration. No environment file
is required. `CODEX_HOME`, Codex `sqlite_home`, and `CODEX_SQLITE_HOME` are
adapter path inputs, not Sessions credentials.
