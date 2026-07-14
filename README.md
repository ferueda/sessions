# Sessions

Local-first search and analysis for AI coding-agent session history.

Sessions will normalize Cursor, Codex, and future agent histories into one faithful local index. Humans and agents can then recover context, inspect decisions, audit drift and verification, and discover recurring work without uploading transcripts.

> **Status: pre-alpha.** The repository foundation, canonical contracts, provider-neutral indexing and reconciliation engine, protected SQLite schema-v3 writer coordination, canonical repository, internal clear maintenance, and ready-index health inspection are implemented. Concrete provider adapters, public index/clear commands, search and query commands, and the packaged Agent Skill are planned and not yet available. The npm package has not been released.

## Why Sessions

- One provider-neutral query model instead of provider-specific workflows.
- Explicit, read-only indexing with no telemetry or cloud dependency.
- Provenance that distinguishes human, injected, delegated, copied, model, tool, and system content.
- Deduplicated evidence counts that do not mistake forks or copied prompts for independent recurrence.
- Human output for exploration and versioned JSON/JSONL for scripts and agents.

## Current quick start

Prerequisites: Node.js 24.16 or newer and pnpm 11.10 through Corepack.

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
node dist/bin/sessions.js paths
node dist/bin/sessions.js paths --format json
```

`doctor` checks the Node runtime, in-memory SQLite FTS5 capabilities, and the existing Sessions index state. For a ready index it also checks database integrity, foreign keys, FTS structure/content/security, run records, and writer-lease state through an immutable snapshot. `paths` reports the Sessions-owned index directory, database, and SQLite sidecar paths. Neither command creates or migrates state, inspects providers, or accesses the network. An uninitialized index is a healthy fresh-install state.

The internal indexing service now owns deterministic source selection, complete discovery, incremental reads, last-good failure behavior, source-scoped reconciliation, and durable bounded reports. Its SQLite writer uses a renewable generation lease, fences every mutation, and recovers abandoned runs safely. Internal clear maintenance removes only the known Sessions database and sidecars. No public command opens these write paths yet, and there are no provider adapters.

## Planned V1

```text
sessions index [--source cursor|codex]
sessions list [filters]
sessions search <text> [filters]
sessions show <source-instance:id> [--entry N --context N]
sessions export <source-instance:id> --format md|json|jsonl
sessions index clear
```

The public delivery target is `npm install --global @ferueda/sessions` or `npx @ferueda/sessions`, after package ownership, cross-platform parity, and trusted publishing are configured.

## Privacy

Provider histories are inputs, never mutation targets. Public indexing will be explicit, local, and network-free. The canonical index is rebuildable derived data with restrictive local permissions and implemented internal only-owned-file clearing; the user-facing clear route remains planned. See the [privacy contract](docs/privacy.md) for promises and limitations.

## Design and roadmap

- [Project intent](docs/project-intent.md)
- [Accepted architecture memo](docs/architecture-memo.md)
- [V1 implementation roadmap](dev/plans/260713-v1-implementation-roadmap.md)
- [CLI contract](docs/reference/cli-contract.md)
- [Architecture decisions](docs/decisions/README.md)
- [Active implementation plans](dev/plans/README.md)

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [contributor index](docs/contributing/index.md). `pnpm check` is the repository definition of done.

## License

MIT
