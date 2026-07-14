# Repository command inventory

`package.json` is the executable source of truth. This inventory explains ownership and side effects; generated CLI help owns exact public flags.

| Command                          | Purpose                                                     | Mutates                         | Network                             |
| -------------------------------- | ----------------------------------------------------------- | ------------------------------- | ----------------------------------- |
| `pnpm install --frozen-lockfile` | Install exact contributor dependencies and prepare hook     | `node_modules/`, local Git hook | Package registry unless cached      |
| `pnpm format`                    | Apply repository formatting                                 | Tracked files                   | No                                  |
| `pnpm format:check`              | Check formatting                                            | No                              | No                                  |
| `pnpm format:docs:check`         | Check Markdown formatting                                   | No                              | No                                  |
| `pnpm lint` / `pnpm lint:fix`    | Check or fix source/test lint                               | Fix variant only                | No                                  |
| `pnpm deps:check`                | Enforce production import graph                             | No                              | No                                  |
| `pnpm typecheck`                 | Strict TypeScript check                                     | No                              | No                                  |
| `pnpm test` / `pnpm test:watch`  | Run tests once or watch                                     | Temporary test state            | No                                  |
| `pnpm test:docs`                 | Run documentation contract tests                            | No                              | No                                  |
| `pnpm clean`                     | Remove compiled output                                      | `dist/`                         | No                                  |
| `pnpm build`                     | Clean and compile distributable JS                          | `dist/`                         | No                                  |
| `pnpm smoke:dist`                | Exercise compiled M5 workflow with a synthetic Codex source | Temporary directory, removed    | No                                  |
| `pnpm smoke:package`             | Offline-install tarball and exercise the same M5 workflow   | Temporary directory, removed    | No after dependencies are installed |
| `pnpm check` / `pnpm check:ci`   | Complete definition-of-done gate                            | Build/temp state                | No after dependencies are installed |
| `pnpm check:docs`                | Run the documentation-only CI gate                          | No                              | No                                  |

`pnpm prepack` rebuilds the package and is run by normal npm publishing/packing flows. The package smoke deliberately packs with lifecycle scripts disabled after an explicit build, preventing recursive smoke execution.

Current public CLI commands are documented in
[the CLI contract](../reference/cli-contract.md). Doctor and paths inspect state
but create no directories, files, migrations, or rollout reads. Index explicitly
creates/updates the durable library from read-only provider inputs; list/show are
library-only reads; forget/data-clear delete only Sessions-owned state. Tests and
smokes use generated providers and protected state beneath temporary directories.
