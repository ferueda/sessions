# Sessions

Local-first search and analysis for AI coding-agent session history.

Sessions will normalize Cursor, Codex, and future agent histories into one faithful local index. Humans and agents can then recover context, inspect decisions, audit drift and verification, and discover recurring work without uploading transcripts.

> **Status: pre-alpha.** The repository foundation, canonical contracts, and `doctor` command are implemented. Indexing, search, provider adapters, and the packaged Agent Skill are planned and not yet available. The npm package has not been released.

## Why Sessions

- One provider-neutral query model instead of provider-specific workflows.
- Explicit, read-only indexing with no telemetry or cloud dependency.
- Provenance that distinguishes human, injected, delegated, copied, model, tool, and system content.
- Deduplicated evidence counts that do not mistake forks or copied prompts for independent recurrence.
- Human output for exploration and versioned JSON/JSONL for scripts and agents.

## Current quick start

Prerequisites: Node.js 24.15 or newer and pnpm 11.10 through Corepack.

```bash
git clone https://github.com/ferueda/sessions.git
cd sessions
corepack enable
pnpm install --frozen-lockfile
pnpm build
node dist/bin/sessions.js doctor
```

Current commands:

```bash
node dist/bin/sessions.js --help
node dist/bin/sessions.js --version
node dist/bin/sessions.js doctor
node dist/bin/sessions.js doctor --format json
```

`doctor` checks the Node runtime and actual SQLite FTS5 support entirely in memory. It does not inspect providers, create an index, or persist data.

## Planned V1

```text
sessions index [--source cursor|codex]
sessions list [filters]
sessions search <text> [filters]
sessions show <source-instance:id> [--entry N --context N]
sessions export <source-instance:id> --format md|json|jsonl
sessions paths
sessions index clear
```

The public delivery target is `npm install --global @ferueda/sessions` or `npx @ferueda/sessions`, after package ownership, cross-platform parity, and trusted publishing are configured.

## Privacy

Provider histories are inputs, never mutation targets. Indexing will be explicit, local, and network-free. The planned canonical index is rebuildable derived data with user-controlled clearing and restrictive local permissions. See the [privacy contract](docs/privacy.md) for promises and limitations.

## Design and roadmap

- [Project intent](docs/project-intent.md)
- [Accepted architecture memo](docs/architecture-memo.md)
- [CLI contract](docs/reference/cli-contract.md)
- [Architecture decisions](docs/decisions/README.md)
- [Active implementation plan](dev/plans/260713-initial-repository-scaffold.md)

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [contributor index](docs/contributing/index.md). `pnpm check` is the repository definition of done.

## License

MIT
