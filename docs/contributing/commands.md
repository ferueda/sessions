# Repository command inventory

`package.json` is the executable source of truth. This inventory explains ownership and side effects; generated CLI help owns exact public flags.

| Command                          | Purpose                                                                 | Mutates                         | Network                             |
| -------------------------------- | ----------------------------------------------------------------------- | ------------------------------- | ----------------------------------- |
| `pnpm install --frozen-lockfile` | Install exact contributor dependencies and prepare hook                 | `node_modules/`, local Git hook | Package registry unless cached      |
| `pnpm format`                    | Apply repository formatting                                             | Tracked files                   | No                                  |
| `pnpm format:check`              | Check formatting                                                        | No                              | No                                  |
| `pnpm format:docs:check`         | Check Markdown formatting                                               | No                              | No                                  |
| `pnpm lint` / `pnpm lint:fix`    | Check or fix source/test lint                                           | Fix variant only                | No                                  |
| `pnpm measure:content-storage`   | Compare legacy and current canonical-content layouts with fixed corpora | Temporary directory, removed    | No                                  |
| `pnpm deps:check`                | Enforce production import graph                                         | No                              | No                                  |
| `pnpm typecheck`                 | Strict TypeScript check                                                 | No                              | No                                  |
| `pnpm test` / `pnpm test:watch`  | Run tests once or watch                                                 | Temporary test state            | No                                  |
| `pnpm test:docs`                 | Run documentation contract tests                                        | No                              | No                                  |
| `pnpm clean`                     | Remove compiled output                                                  | `dist/`                         | No                                  |
| `pnpm build`                     | Clean and compile distributable JS                                      | `dist/`                         | No                                  |
| `pnpm smoke:dist`                | Exercise compiled M6 index/search/next-cursor/show with synthetic Codex | Temporary directory, removed    | No                                  |
| `pnpm smoke:package`             | Offline-install tarball and exercise the same M6 workflow               | Temporary directory, removed    | No after dependencies are installed |
| `pnpm check` / `pnpm check:ci`   | Complete definition-of-done gate                                        | Build/temp state                | No after dependencies are installed |
| `pnpm check:docs`                | Run the documentation-only CI gate                                      | No                              | No                                  |

`pnpm prepack` rebuilds the package and is run by normal npm publishing/packing flows. The package smoke deliberately packs with lifecycle scripts disabled after an explicit build, preventing recursive smoke execution.

`pnpm measure:content-storage` is an opt-in diagnostic outside `pnpm check`. It
uses deterministic generic content in temporary SQLite databases, removes the
temporary directory even on failure, and prints only aggregate corpus
parameters, per-object/file byte counts, and interning timings. The structural
checks require exact-content ID reuse, collision coexistence, no target index on
text, and a realistic target database no larger than 60% of the legacy layout.
Timings are report-only and can vary by machine and SQLite version.

Current public CLI commands are documented in
[the CLI contract](../reference/cli-contract.md). Doctor and paths inspect state
but create no directories, files, migrations, or rollout reads. Index explicitly
creates/updates the durable library from read-only provider inputs;
list/search/show are library-only reads; forget/data-clear delete only
Sessions-owned state. Tests and smokes use generated providers and protected
state beneath temporary directories.
