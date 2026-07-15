# Current architecture

Status: M6 Codex retained-library query vertical slice complete.

This map describes code that exists now. The
[architecture memo](../architecture-memo.md) describes the accepted V1 target.

## Runtime flow

```text
src/bin/sessions.ts
  -> src/cli/{run,program,render}.ts

doctor / paths
  -> src/application/{run-doctor,get-paths,source-diagnostic}.ts
  -> runtime + SQLite + library-state diagnostics
  -> lazy Codex probe

index
  -> src/adapters/codex/source.ts
  -> src/application/run-index.ts
  -> writer-leased SourceDiscoveryWorkspace
  -> src/infrastructure/sqlite/sqlite-session-index.ts

list / search / show
  -> src/application/{list-sessions,search-sessions,show-session}.ts
  -> immutable library reader (no adapter)
  -> src/infrastructure/sqlite/sqlite-session-query.ts (list/search only)

forget / data clear
  -> src/application/{forget-session,clear-index}.ts
  -> src/infrastructure/sqlite/index-maintenance.ts
```

The composition root is the only production module that imports both a concrete
adapter and infrastructure. It resolves Codex lazily: help, version, list,
search, show, forget, and data clear do not resolve provider configuration.
Index, paths, and doctor intentionally resolve or probe the registered source.

## Ownership

| Path                                             | Owner                                                                                  |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `src/domain/`                                    | Canonical session/query/lineage values, identity, provenance, and validation           |
| `src/application/ports/`                         | Source, library, query, lifecycle, maintenance, health, and diagnostic contracts       |
| `src/application/source-*.ts`                    | Complete input fingerprints and typed source failures                                  |
| `src/application/validate-session.ts`            | Immutable adapter-read admission                                                       |
| `src/application/discover-sessions.ts`           | Complete discovery admission, duplicate policy, and deterministic ordering             |
| `src/application/run-index.ts`                   | Provider-neutral incremental capture and source-presence reconciliation                |
| `src/application/{list,search,show}-sessions.ts` | Provider-free retained-library reads, query admission, and bounds                      |
| `src/application/*report.ts`                     | Versioned provider-neutral operational reports                                         |
| `src/adapters/codex/`                            | Codex path/state/rollout discovery and canonical normalization                         |
| `src/infrastructure/state/`                      | Application-data paths, state inspection, and leased ephemeral discovery workspace     |
| `src/infrastructure/sqlite/`                     | Schema, canonical/query repositories, cursors, FTS repair, leases, and maintenance     |
| `src/cli/`                                       | Command grammar, terminal-safe rendering, streams, and exit behavior                   |
| `src/bin/`                                       | Sole concrete composition root                                                         |
| `scripts/`                                       | Build and delivery smoke helpers; not published runtime                                |
| `test/`                                          | Cross-layer contracts, generated provider fixtures, integration, and delivery evidence |

Portable export, Cursor, packaged Agent Skills, and a public adapter ABI do not
exist yet. M7 owns transcript-bearing JSON/JSONL and portable export; M6
list/search/show output is human-facing.

The current runtime intentionally adds only `smol-toml`. Provider and canonical
input use focused handwritten bounded validators; Zod is deferred until a
concrete public-schema benefit justifies its runtime/package cost. M7 owns the
versioned public transcript DTOs, deterministic document digest, JSON/JSONL, and
portable export rather than freezing partial equivalents in M6.

## Dependency direction

- Domain -> domain only.
- Application -> application/domain.
- Infrastructure -> infrastructure/application/domain.
- Adapters -> adapters/application/domain.
- CLI -> CLI/application/domain.
- Binary composition -> any production layer.

`scripts/check-dependencies.ts` enforces explicit relative-import boundaries and
fails on an empty scan. Oxlint rejects cycles. `pnpm deps:check` is the focused
gate.

## Capture boundary

The source port is `probe` / `discover(workspace)` / `read`. The application
engine selects sources, admits a complete discovery set, compares fingerprints,
owns last-good behavior, records coverage/presence, and reconciles unseen
sessions. Adapters only turn provider evidence into candidates and canonical
documents.

Codex discovery snapshots `state_5.sqlite` and any active WAL bytes into a random
private child of the Sessions `.scratch` workspace. The adapter never opens the
provider database with SQLite and never receives the workspace root or writer
lease. Snapshot validation fails closed if concurrent checkpoint/reset evidence
cannot prove one complete generation. Rollout reads stream plain JSONL or Zstd,
verify live file identity before and after consumption, and admit no partial
document after change or parse failure.

## Durable library

The owned directory is platform application data, or the exact absolute
`SESSIONS_DATA_DIR` override. It contains `sessions.sqlite3`, known WAL/SHM
sidecars, and the exact ephemeral `.scratch` child. The pre-public cache path and
legacy Harness JSONL cache are never reused, migrated, or deleted.

The current baseline creates canonical text/omitted segments, exact tool identity
and linkage, complete/unknown lineage coverage, source instances, latest
successful fingerprints/documents, capture timestamps, source presence/coverage,
bounded run evidence, a random library identity, derived external-content FTS,
and writer coordination directly. Only text enters interning and FTS. Canonical
text keeps a stable integer content ID, stores the fixed SHA-256 digest as a
32-byte BLOB, and narrows interning through a non-unique digest index before
requiring exact binary text equality. A canonical insert guard rejects duplicate
digest-and-text rows without preventing unequal collision members. Omitted content
stores class, source type, ordinal, and provenance—never media bytes or references.

Canonical replacement captures the prior document's distinct content IDs before
cascade deletion, then prunes only those still unreferenced after insertion in
the same transaction. Replacement is not a whole-library orphan-repair path; a
legitimate producer of unrelated orphans would require explicit writer
maintenance outside the per-session hot path.

One renewable generation lease serializes `index`, `forget`, and `clear`. Every
mutation asserts ownership inside its transaction. Expired takeover fences stale
writers between transactions and interrupts abandoned active index runs. An
immediate transaction that has already serialized the writer may renew its
unchanged exact generation, purpose, and token at entry and exit even if wall
time crosses expiry, because SQLite prevents a competing takeover while that
transaction is held. Rollback or process failure discards both the transactional
renewal and partial work. Unsupported development databases fail closed; no
pre-release schema cutover or lease carry-forward exists.

A complete scan marks unseen retained sessions `missing`; unavailable or
incomplete discovery leaves effective source state `unknown`. Neither deletes
canonical evidence. A failed discovered read preserves the last-good document and
marks it stale. Reappearance restores `present` and unchanged fingerprints avoid
another transcript read.

`forget` transactionally deletes one selected tracking identity and its owned
canonical evidence while preserving aggregate redacted run history, shared text,
and incoming relations owned by other sessions. `data clear --yes` removes only
the validated Sessions database/WAL/SHM paths and exact scratch subtree. Neither
operation touches a provider.

Immutable readers expose separate `sessions` reconstruction and provider-neutral
`query` ports. List/search use one SQLite snapshot for complete pages, context,
and support; show reconstructs the exact canonical document. None resolve or
reopen Codex, so retained content remains usable after provider disappearance.
Query cursors bind the query plus library identity/writer generation. An explicit
leased index writer can rebuild FTS-only damage from canonical content; doctor
stays read-only and reports canonical integrity separately from projection
health.

## Query boundary

`src/domain/session-query.ts` owns validated immutable filters, limits, context,
cursors, pages, hits, and support values. `src/domain/session-lineage.ts` owns the
iterative provider-neutral root policy. `src/application/ports/session-query.ts`
defines the minimal list/search repository; services own defaults and
fresh-library behavior.

SQLite owns literal FTS translation, parameterized filter SQL, deterministic
rank/order, bounded context assembly, query-wide counts, and cursor encoding.
`fts-projection.ts` is the shared bootstrap/repair definition. These modules do
not import adapters. Codex supplies canonical lineage coverage/relations and
observed tool evidence only; it cannot decide roots, counts, filters, ranking, or
presentation.

## Build

Source uses explicit `.ts` imports and erasable TypeScript. `tsconfig.build.json`
compiles only `src/` into `dist/`, rewrites relative extensions to `.js`, and
emits source maps. The package exposes no library API; published consumers execute
`dist/bin/sessions.js`.
