# Current architecture

Status: M8 agent analysis retrieval is in progress; query-scoped lineage
resolution and rank-first search hydration are complete, and bounded show/export
ranges are next.

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

list / search / show / export
  -> src/application/{list-sessions,search-sessions,show-session,export-session}.ts
  -> shared application selection and truncation
  -> immutable library reader (no adapter)
  -> src/infrastructure/sqlite/sqlite-session-query.ts (list/search only)

structured query/export output
  -> src/cli/structured-output.ts
  -> src/cli/{encode-json-output,encode-jsonl-output,structured-output-encoding}.ts
  -> JSON bundle or independently attributable JSONL records
  -> encoded-size admission before stdout

forget / data repair-orphans / data compact / data clear
  -> src/application/{forget-session,repair-orphaned-content,compact-index,clear-index}.ts
  -> src/infrastructure/sqlite/index-maintenance.ts
```

The composition root is the only production module that imports both a concrete
adapter and infrastructure. It resolves Codex lazily: help, version, list,
search, show, export, forget, data repair-orphans, data compact, and data clear
do not resolve provider configuration.
Index, paths, and doctor intentionally resolve or probe the registered source.

## Ownership

| Path                                                              | Owner                                                                                  |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `src/domain/`                                                     | Canonical values, public projection/JCS digest, identity, provenance, and validation   |
| `src/application/ports/`                                          | Source, library, query, lifecycle, maintenance, health, and diagnostic contracts       |
| `src/application/source-*.ts`                                     | Complete input fingerprints and typed source failures                                  |
| `src/application/validate-session.ts`                             | Immutable adapter-read admission                                                       |
| `src/application/discover-sessions.ts`                            | Complete discovery admission, duplicate policy, and deterministic ordering             |
| `src/application/run-index.ts`                                    | Provider-neutral incremental capture and source-presence reconciliation                |
| `src/application/{list-sessions,search-sessions,show-session}.ts` | Provider-free retained-library reads, query admission, and bounds                      |
| `src/application/export-session.ts`                               | Provider-free one-snapshot export and bounded/full selection                           |
| `src/application/session-presentation.ts`                         | Shared title, relation, entry, segment, and UTF-8 text selection                       |
| `src/application/*report.ts`                                      | Versioned provider-neutral operational reports                                         |
| `src/adapters/codex/`                                             | Codex path/state/rollout discovery and canonical normalization                         |
| `src/infrastructure/state/`                                       | Application-data paths, state inspection, and leased ephemeral discovery workspace     |
| `src/infrastructure/sqlite/`                                      | Schema, canonical/query repositories, cursors, FTS repair, leases, and maintenance     |
| `src/cli/structured-output.ts`                                    | Closed schema-1 DTO construction, recursive validation, and freezing                   |
| `src/cli/*structured*`, `encode-*-output.ts`                      | JSON/JSONL encoding and aggregate output admission                                     |
| `src/cli/`                                                        | Command grammar, terminal-safe rendering, streams, and exit behavior                   |
| `src/bin/`                                                        | Sole concrete composition root                                                         |
| `scripts/`                                                        | Build and delivery smoke helpers; not published runtime                                |
| `test/`                                                           | Cross-layer contracts, generated provider fixtures, integration, and delivery evidence |

Portable JSON/JSONL export and transcript-bearing JSON/JSONL list/search/show
exist. Agent-efficient corpus selection, Cursor, packaged Agent Skills, and a
public adapter ABI do not exist yet. M7 owns one closed public document projection, its
deterministic digest, retained attribution, shared bounded selection, and the
exact schema-1 machine records documented in
[structured output](../reference/structured-output.md).

The current runtime dependencies remain `commander` and `smol-toml`. Provider and
canonical input use focused handwritten bounded validators; Zod is deferred until
a concrete public-schema benefit justifies its runtime/package cost. Focused
domain code owns the public projection and digest without another dependency.
Focused application code selects safe public values once before human or machine
rendering; focused CLI code builds and validates closed DTOs without another
runtime schema dependency.

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
writer coordination, and the fixed public-document digest directly. The digest
scheme and exact 32-byte value are stored on the canonical session row in the
same replacement transaction as the document. Only text enters interning and FTS. Canonical
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

One renewable generation lease serializes `index`, `forget`, `repair`, `compact`,
and `clear`. Every mutation asserts ownership inside its transaction. Expired
takeover fences stale
writers between transactions and interrupts abandoned active index runs. An
immediate transaction that has already serialized the writer may renew its
unchanged exact generation, purpose, and token at entry and exit even if wall
time crosses expiry, because SQLite prevents a competing takeover while that
transaction is held. Rollback or process failure discards both the transactional
renewal and partial work. Unsupported development databases fail closed; no
pre-release schema cutover or lease carry-forward exists.
The persisted document digest changed the single schema-1 baseline checksum.
Earlier development libraries are not migrated or cleared automatically; use a
fresh `SESSIONS_DATA_DIR` or manually remove only the obsolete Sessions-owned
directory, then index again.

A complete scan marks unseen retained sessions `missing`; unavailable or
incomplete discovery leaves effective source state `unknown`. Neither deletes
canonical evidence. A failed discovered read preserves the last-good document and
marks it stale. Reappearance restores `present` and unchanged fingerprints avoid
another transcript read.

`forget` transactionally deletes one selected tracking identity and its owned
canonical evidence while preserving aggregate redacted run history, shared text,
incoming relations owned by other sessions, and unrelated historical orphans.
It prunes only former content IDs that become unreferenced. Immutable health
reports content reachability independently from canonical, foreign-key, and FTS
health. `data repair-orphans` owns the only whole-library canonical orphan scan:
it holds a dedicated repair lease across fixed internal committed batches,
deletes only still-unreferenced candidates with matching FTS rows, and reports
aggregate rows and logical UTF-8 bytes. It is provider-free, exposes no public
batch/cursor state, and is safe to restart after a failure. `data clear --yes`
removes only the validated Sessions database/WAL/SHM paths and exact scratch
subtree. None of these operations touches a provider.

The current baseline selects SQLite `auto_vacuum=INCREMENTAL` only while creating
a genuinely new owned database, before WAL or schema writes. Existing files in
another mode fail closed; readers enforce the mode and doctor reports it
separately. `data compact` acquires a dedicated lease, checkpoints WAL, and runs
bounded incremental-vacuum transactions until no whole free page remains. Every
committed batch is durable and rerunnable. The operation reports observed main
database file lengths only; it does not run full `VACUUM`, repack partial pages,
delete canonical rows, or claim forensic erasure.

Orphan repair is logical canonical deletion, not physical reclamation. A later
doctor proves reachability; `data compact` remains the separate explicit route
for returning reusable whole pages. Orphan repair never rebuilds FTS. Its
candidate deletes compose with the existing canonical-content FTS triggers,
while index-writer projection repair remains the distinct operation that rebuilds
derived FTS from healthy canonical content.

Immutable readers expose separate `sessions` reconstruction and provider-neutral
`query` ports. List/search use one SQLite snapshot for complete pages, context,
and support; show/export reconstruct the exact canonical document. Retained summaries
include successful capture time, effective source-observation time, last-good
adapter version, and the stored document digest. Show/export read summary and body
from one immutable snapshot and requires their stored digests to agree. Full
document reads reconstruct the closed public projection and verify the persisted
digest; a mismatch is canonical corruption, not FTS damage. List/search read the
stored digest directly and do not reconstruct every document. None resolve or
reopen Codex, so retained content remains usable after provider disappearance.
Query cursors bind the query plus library identity/writer generation. An explicit
leased index writer can rebuild FTS-only damage from canonical content; doctor
stays read-only and reports canonical integrity, content reachability, and
projection health separately.

The public document projection is a field-by-field allowlist. It includes title,
provider timestamps, lineage coverage and ordered relations, ordered entries,
safe tool/linkage evidence, exact text/content hashes, and admitted non-text
omission facts. It excludes the root identity, workspace, locators, source
metadata, capture/source observations, freshness, adapter version, and the digest
itself. `sha256-sessions-document-jcs-v1` hashes the complete versioned projection
with fragment-fed RFC 8785/JCS serialization and no Unicode normalization. The
digest is document evidence only: it is not session identity, a signature, an
authenticity result, or a safety signal.

## Query boundary

`src/domain/session-query.ts` owns validated immutable filters, limits, context,
cursors, pages, hits, and support values. `src/domain/session-lineage.ts` owns the
iterative provider-neutral root policy. `src/application/ports/session-query.ts`
defines the minimal list/search repository; services own defaults and
fresh-library behavior.

SQLite owns literal FTS translation, parameterized filter SQL, deterministic
rank/order, bounded context assembly, query-wide counts, and cursor encoding.
Search ranks compact coordinates first, keeps the extra rank-only row used for
pagination, and hydrates text, digest, and snippets only for the selected page.
Snippet markers are checked against those selected canonical texts and retried
on collision, so search does not scan or hydrate the rest of the library.
Support remains exact and query-wide rather than being inferred from the page.
`fts-projection.ts` is the shared bootstrap/repair definition. These modules do
not import adapters. Codex supplies canonical lineage coverage/relations and
observed tool evidence only; it cannot decide roots, counts, filters, ranking, or
presentation.

The application layer performs title/transcript selection once, before choosing
a human or machine renderer. Show keeps its existing entry window, then uses the
same relation/segment/text bounds as default export. Export full mode removes
presentation selection only; it does not broaden the public projection. The CLI
maps these safe values field by field into closed schema-1 DTOs, recursively
validates them, encodes the whole result, and applies the exact 16 MiB bound
before stdout. JSONL is independently attributable but is not a direct SQLite
stream. Format never enters list/search query fingerprints.

## Build

Source uses explicit `.ts` imports and erasable TypeScript. `tsconfig.build.json`
compiles only `src/` into `dist/`, rewrites relative extensions to `.js`, and
emits source maps. The package exposes no library API; published consumers execute
`dist/bin/sessions.js`.
