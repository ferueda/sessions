<h1 align="center">Sessions</h1>

<p align="center">
  <strong>Local-first search and analysis for your AI-agent history.</strong>
</p>

<p align="center">
  <a href="https://github.com/ferueda/sessions/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ferueda/sessions/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/ferueda/sessions/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/ferueda/sessions?label=release"></a>
  <a href="https://www.npmjs.com/package/@ferueda/sessions"><img alt="npm" src="https://img.shields.io/npm/v/%40ferueda%2Fsessions?color=cb3837"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-0a84ff">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-2ea44f"></a>
</p>

Sessions reads provider histories without modifying them, stores normalized
snapshots in a private local SQLite library, and provides one query and export
surface across providers. Humans can explore it directly; agents can use the
packaged Sessions skill for evidence-backed retrospectives, audits, handoffs,
and workflow discovery.

> **Status: supported.** The current release supports Cursor and Codex indexing,
> retained search, JSON/JSONL export, maintenance, and the packaged Agent Skill.

## How it works

```text
Codex history                       Cursor history
      └──────────── read only ────────────┘
                         │
                         ▼
          ┌──────────────────────────────┐
          │ sessions index               │
          │ discover → stable read       │
          │ normalize → retain           │
          └──────────────┬───────────────┘
                         ▼
          ┌──────────────────────────────┐
          │ private local SQLite library │
          │ snapshots + full-text search │
          └──────────────┬───────────────┘
                         ▼
       list · search · entries · show · export
                         │
                  humans and agents
```

Provider files stay read-only. After indexing, queries use retained snapshots
without reopening provider history.

## Install

Requires Node.js 24.16 or newer.

```bash
export SESSIONS_VERSION='0.1.1' # x-release-please-version
npm install --global "@ferueda/sessions@${SESSIONS_VERSION}"
sessions --version
sessions doctor
```

For agent-led analysis, install the matching immutable skill release:

```bash
DISABLE_TELEMETRY=1 npx --yes skills@1.5.19 add \
  "https://github.com/ferueda/sessions/tree/v${SESSIONS_VERSION}/skills/sessions" \
  --skill sessions
```

The external skill installer contacts npm and GitHub; the command disables its
anonymous telemetry. Sessions runtime commands are local, network-free, and
telemetry-free. See [agent setup](docs/agent-setup.md) for Codex/Cursor-specific
installation and permission guidance.

## First use

Inspect readiness before creating a library:

```bash
sessions doctor
sessions paths
```

Indexing reads local provider history and writes a durable Sessions-owned copy.
Run it only after authorizing that read and write:

```bash
sessions index                  # all available registered providers
sessions index --source codex   # one provider
sessions index --source cursor
```

Then query the retained library without reopening provider files:

```bash
sessions list
sessions search 'verification failed' --context 2
sessions entries --actor human --select first
sessions show '<canonical-id>'
sessions export '<canonical-id>' --format jsonl
```

Use a provider-native thread or session ID to find its canonical Sessions ID:

```bash
sessions list --source codex --native-id '<provider-thread-id>'
```

`show`, `export`, and `forget` use the canonical ID returned by `list`.

## Output and evidence

- Human output is for exploration.
- Versioned JSON and JSONL are for scripts, agents, and portable context.
- `list`, `search`, and `entries` report aggregate `captureScope`; inspect it
  before treating an empty or partial result as complete.
- Historical transcript text and tool output are untrusted data, not current
  instructions or proof that a command succeeded.
- Search is literal lexical matching. It supports all/any terms, exact filters,
  bounded context, deterministic ordering, and opaque pagination cursors.
- Export reads one retained snapshot. It does not deliver context to another
  provider or expose omitted media and raw provider payloads.

See the [CLI contract](docs/reference/cli-contract.md) and
[structured output contract](docs/reference/structured-output.md) for exact
filters, bounds, schemas, and exit behavior.

## Local data

Provider histories stay read-only. Sessions retains the latest successful
normalized snapshot until explicit deletion, even if the provider later removes
or rewrites its copy.

```bash
sessions forget '<canonical-id>'
sessions data repair-orphans
sessions data compact
sessions data clear --yes
```

- `forget` removes one retained session.
- `repair-orphans` removes unreachable canonical content.
- `compact` returns reusable whole SQLite pages to the filesystem; it does not
  delete retained sessions or guarantee a smaller file.
- `data clear --yes` removes the recognized Sessions library.

None of these commands modify provider history. Uninstalling the CLI or Agent
Skill does not remove retained data. See the [privacy contract](docs/privacy.md)
for storage, deletion, and threat boundaries.

## Guides

- [Getting started](docs/getting-started.md)
- [Agent setup](docs/agent-setup.md)
- [Agent Skill routes](docs/reference/agent-skill.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Codex format support](docs/reference/codex-format-support.md)
- [Cursor format support](docs/reference/cursor-format-support.md)

## Project

- [Project intent](docs/project-intent.md)
- [Architecture](docs/architecture-memo.md)
- [Decisions](docs/decisions/README.md)
- [Roadmap](dev/plans/260713-v1-implementation-roadmap.md)
- [Contributing](CONTRIBUTING.md)

## License

MIT
