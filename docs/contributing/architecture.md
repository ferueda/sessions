# Current architecture

Status: the post-V1 revision-manifest milestone and certified index-recovery
work are complete over the provider-neutral library, query, export, and
maintenance contracts.

This map describes code that exists now. The
[architecture memo](../architecture-memo.md) describes the accepted V1 target.

## Runtime flow

```text
agent host
  -> skills/sessions/SKILL.md
  -> one routed evidence playbook
  -> public sessions CLI

src/bin/sessions.ts
  -> src/cli/{run,program,render}.ts

doctor / paths
  -> src/application/{run-doctor,get-paths,source-diagnostic}.ts
  -> runtime + SQLite + library-state diagnostics
  -> lazy registered-source probes
  -> doctor only: interactive phase progress + optional aggregate timing

index
  -> src/adapters/{cursor,codex}/source.ts
  -> src/application/run-index.ts
  -> writer-leased SourceCaptureWorkspace for discovery and changed reads
  -> src/infrastructure/sqlite/sqlite-session-index.ts
  -> transaction-bound schema-3 index-generation receipt
  -> optional aggregate timing at existing application/port boundaries

list / search / entries / manifest / show / export
  -> src/application/{list-sessions,search-sessions,list-session-entries,create-session-manifest,show-session,export-session}.ts
  -> shared application selection and truncation
  -> immutable library reader (no adapter)
  -> src/infrastructure/sqlite/sqlite-session-query.ts (list/search/entries)
  -> src/infrastructure/sqlite/sqlite-session-entry-query.ts (entries only)
  -> src/infrastructure/sqlite/sqlite-session-manifest.ts (manifest only)
  -> one same-snapshot capture scope on list/search/entries pages and manifest

structured query/manifest/export output
  -> src/cli/structured-output.ts
  -> src/cli/{encode-json-output,encode-jsonl-output,structured-output-encoding}.ts
  -> JSON bundle or independently attributable JSONL records
  -> encoded-size admission before stdout

forget / data repair-orphans / data compact / data clear
  -> src/application/{forget-session,repair-orphaned-content,compact-index,clear-index}.ts
  -> src/infrastructure/sqlite/index-maintenance.ts
```

The composition root is the only production module that imports both a concrete
adapter and infrastructure. It resolves Cursor and Codex lazily: help, version,
list, search, entries, manifest, show, export, forget, data repair-orphans, data
compact, and data clear do not resolve provider configuration.
Index, paths, and doctor resolve registered sources. Implicit indexing skips
only valid unavailable sources; explicit selection and all other probe failures
remain strict.

## Ownership

| Path                                                                                                           | Owner                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/domain/`                                                                                                  | Canonical values, public projection/JCS digest, document metrics, manifest/query values, identity, provenance, capture scope, and validation |
| `src/application/ports/`                                                                                       | Source, library, query, lifecycle, maintenance, health, and diagnostic contracts                                                             |
| `src/application/source-*.ts`                                                                                  | Complete input fingerprints and typed source failures                                                                                        |
| `src/application/validate-session.ts`                                                                          | Immutable adapter-read admission                                                                                                             |
| `src/application/discover-sessions.ts`                                                                         | Complete discovery admission, duplicate policy, and deterministic ordering                                                                   |
| `src/application/run-index.ts`                                                                                 | Provider-neutral incremental capture and source-presence reconciliation                                                                      |
| `src/application/index-timing.ts`                                                                              | Optional best-effort measurement around existing indexing operations                                                                         |
| `src/application/{doctor-progress,doctor-timing}.ts`                                                           | Fixed best-effort doctor phases and measurement around existing health operations                                                            |
| `src/application/{list-sessions,search-sessions,list-session-entries,create-session-manifest,show-session}.ts` | Provider-free retained-library reads, query admission, and bounds                                                                            |
| `src/application/export-session.ts`                                                                            | Provider-free one-snapshot export and bounded/full selection                                                                                 |
| `src/application/session-presentation.ts`                                                                      | Shared title, relation, entry, segment, and UTF-8 text selection                                                                             |
| `src/application/session-root-presentation.ts`                                                                 | Query-derived known/unknown root copying                                                                                                     |
| `src/application/*report.ts`                                                                                   | Versioned provider-neutral operational reports                                                                                               |
| `src/adapters/cursor/`                                                                                         | Cursor path/store discovery and canonical normalization                                                                                      |
| `src/adapters/codex/`                                                                                          | Codex path/state/rollout discovery and canonical normalization                                                                               |
| `src/infrastructure/state/`                                                                                    | Application-data paths, state inspection, and leased ephemeral capture workspace                                                             |
| `src/infrastructure/sqlite/`                                                                                   | Schema, canonical/query and capture-scope readers, cursors, FTS repair, clean/recovery proof, leases, and maintenance                        |
| `src/infrastructure/runtime/index-timings.ts`                                                                  | In-memory allowlisted indexing timing aggregation                                                                                            |
| `src/infrastructure/runtime/doctor-timings.ts`                                                                 | In-memory allowlisted doctor timing aggregation                                                                                              |
| `src/cli/structured-output.ts`                                                                                 | Closed schema-1 DTO construction, recursive validation, and freezing                                                                         |
| `src/cli/*structured*`, `encode-*-output.ts`                                                                   | JSON/JSONL encoding and aggregate output admission                                                                                           |
| `src/cli/`                                                                                                     | Command grammar, terminal-safe rendering, streams, and exit behavior                                                                         |
| `src/bin/`                                                                                                     | Sole concrete composition root                                                                                                               |
| `skills/sessions/`                                                                                             | Model-invoked routing plus evidence-first analysis playbooks over the public CLI                                                             |
| `scripts/`                                                                                                     | Build and delivery smoke helpers; not published runtime                                                                                      |
| `test/`                                                                                                        | Cross-layer contracts, generated provider fixtures, integration, and delivery evidence                                                       |

Portable JSON/JSONL export, transcript-free JSON/JSONL manifest, and
transcript-bearing JSON/JSONL list/search/entries/show exist. Agent-efficient
corpus selection works across retained Cursor and Codex
sessions; the packaged Agent Skill routes seven analysis playbooks over that
surface. A public adapter ABI does not exist yet. M7 owns one closed public
document projection, its deterministic digest, retained
attribution, shared bounded selection, and the exact schema-1 machine records documented in
[structured output](../reference/structured-output.md).

The skill is presentation and guidance, not another runtime layer. It reads no
provider or SQLite files, defines no hidden query, and cannot authorize indexing
or mutation. Its binding evidence protocol starts routine work with paths for
readiness and takes evidence availability from each query's same-snapshot
capture scope. Doctor is reserved for explicit full audits, suspected damage,
and post-maintenance verification. The protocol also requires explicit indexing
authority, bounded structured queries, reproducible IDs and ordinals, facts
before interpretation, capture scope distinct from search support, visible
omissions, and no automatic project, skill, settings, provider, or history edits.

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

The source port is `probe` / `discover(workspace)` /
`read(candidate, workspace)`, plus an optional adapter-version replacement
guard.
The exact writer-owned capture workspace reaches discovery and changed reads.
The application engine first applies the provider-neutral optional-source rule,
then admits a complete discovery set for each attempted source,
compares fingerprints, owns last-good behavior, and holds first-attempt
`source-changed` outcomes until the primary pass finishes. It then performs at
most one fresh rediscovery per source, retries only affected original identities,
records their terminal outcomes, and uses the primary discovery as the sole
coverage and missing-reconciliation snapshot. Adapters only turn provider
evidence into candidates and canonical documents; they do not own retry policy.

Unchanged candidates receive no read call or read-time staging. Workspace-owned
setup, cleanup, or lease failures abort the complete index operation instead of
being recorded as provider failures; ordinary source failures keep their current
typed admission and last-good behavior.

Codex discovery snapshots `state_5.sqlite` and any active WAL bytes into a random
private child of the Sessions `.scratch` workspace. The adapter never opens the
provider database with SQLite and never receives the workspace root or writer
lease. Snapshot validation fails closed if concurrent checkpoint/reset evidence
cannot prove one complete generation. The admitted snapshot copies each
identity-checked provider file while hashing it, then hashes one freshly opened
post-copy provider set and requires both digests to match. Codex materializes
the admitted thread cohort and its spawn edges with one binary-ordered set query;
orphan edges remain outside the cohort. Rollout reads stream plain JSONL or
Zstd, verify live file identity before and after consumption, and admit no
partial document after change or parse failure.

Cursor discovery traverses only its documented local store grammar. It snapshots
selected SQLite main/WAL bytes into the same private workspace, never opens
provider SHM, and normalizes the two rich store families or streams one exact
recognized JSONL fallback from the
[Cursor format support reference](../reference/cursor-format-support.md).
Within one already ordered parent scope, chat directories, agent-store
directories, and transcript identity directories use a fixed eight-worker pool.
Each leaf returns a local fragment, and the adapter waits for all started work
and flattens successful fragments or selects failures in original binary order.
Parent scopes, catalog snapshots, changed reads, and the two complete inventory
passes remain sequential.
Rich evidence owns a shared native ID. Reduced JSONL can promote to rich but
cannot replace a retained rich snapshot; the provider-neutral engine records an
unsupported candidate and keeps last-good evidence stale. Duplicate unowned
JSONL basenames fail as one candidate. Legacy and cloud-only history remain
outside current coverage.

## Durable library

The owned directory is platform application data, or the exact absolute
`SESSIONS_DATA_DIR` override. It contains `sessions.sqlite3`, known WAL/SHM
sidecars, one private bounded writer-clean proof with recognized temporary
residue, and the exact ephemeral `.scratch` child. The pre-public cache path and
legacy Harness JSONL cache are never reused, migrated, or deleted.

The current baseline creates canonical text/omitted segments, exact tool identity
and linkage, complete/unknown lineage coverage, source instances, latest
successful fingerprints/documents, capture timestamps, source presence/coverage,
bounded run evidence, a random library identity, derived external-content FTS,
writer coordination, a rebuildable index-generation receipt, and the fixed
public-document digest directly. The digest scheme and exact 32-byte value are
stored on the canonical session row in the same replacement transaction as the
document. Only text enters interning and FTS. Canonical
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
and `clear`. Acquisition makes the new generation dirty. Every mutation asserts
ownership inside its transaction. Expired takeover fences stale
writers between transactions and interrupts abandoned active index runs. An
immediate transaction that has already serialized the writer may renew its
unchanged exact generation, purpose, and token at entry and exit even if wall
time crosses expiry, because SQLite prevents a competing takeover while that
transaction is held. Rollback or process failure discards both the transactional
renewal and partial work. Unsupported development databases fail closed; no
pre-release schema cutover or lease carry-forward exists.

Only a normal index close may atomically seal and release its exact generation
after proportional document/affected-FTS proof. It then closes and hardens the
database and publishes a private post-close proof bound to the library,
generation, schema, and final database stat. A ready, no-sidecar, current-schema
open with both matching records uses constant-size schema and FTS structure
checks. The clean proof is preferred for normal free state.

Schema 3 adds one strict singleton receipt with format version, exact index
generation, schema version, SQLite schema cookie, and monotonic operation
sequence. The exact index owner initializes sequence zero only after open-time
setup succeeds. Starting/finishing runs, unchanged/failure/missing batches, and
canonical replacement advance it once after their local postconditions in the
same leased transaction. On an exact expired index owner, a matching receipt and
valid bounded catalog/FTS structure permit `certified-recovery`: acquisition
interrupts the abandoned run, clears its receipt, and advances ownership without
global validation scans. The new invocation still starts discovery from the
beginning.

Missing, altered, malformed, stale, free, live, maintenance, migration-era, or
wrong-generation/schema/cookie receipt evidence is not trusted. Live and
clear-only ownership retain their lifecycle precedence; otherwise the writer
uses the full canonical, foreign-key, and FTS validation/repair path. Missing or
altered receipt-table structure is repaired only under the exact lease and still
requires full validation. Every proven mode opens the capture workspace and
configures FTS before creating its new sequence-zero receipt. The receipt's
bounded metadata contains no transcript, provider identity, local path, content
hash, lease token, timestamp, or timing data.

The schema-2-to-3 migration preserves retained evidence and does not backfill a
receipt. Its first schema-3 writer therefore completes full validation before
creating proof. Earlier unsupported development libraries are not migrated or
cleared automatically; use a fresh `SESSIONS_DATA_DIR` or manually remove only
the obsolete Sessions-owned directory, then index again.

A complete scan marks every unseen tracked session `missing`; unavailable or
incomplete discovery leaves effective source state `unknown`. Neither deletes
canonical evidence or tracking-only failure state. A failed first capture can
therefore be `unindexed + missing` without a manufactured document. A failed
refresh preserves the last-good document and marks it stale. Reappearance
restores `present`, and unchanged retained fingerprints avoid another transcript
read.

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
`query` ports. List/search/entries use one SQLite snapshot for complete pages,
capture scope, context, and support; manifest uses one snapshot for its complete
bounded cohort, capture scope, stored metrics, and whole-library root
resolution; show/export reconstruct the exact canonical document. Retained summaries
include successful capture time, effective source-observation time, last-good
adapter version, and the stored document digest. Show/export read summary and body
from one immutable snapshot and requires their stored digests to agree. Full
document reads reconstruct the closed public projection and verify the persisted
digest plus stored document metrics; a mismatch is canonical corruption, not
FTS damage. List/search/manifest read the stored digest directly and do not
reconstruct every document. None resolve or
reopen a provider, so retained content remains usable after provider disappearance.
Query cursors bind the query plus library identity/writer generation. An explicit
leased index writer can rebuild FTS-only damage from canonical content. Doctor
stays read-only and reports canonical integrity, content reachability,
projection health, and the global capture aggregate separately. Canonical health
merges ordered whole-library header, relation, entry, occurrence/content, and
tracking scans, retains at most one reconstructed document at a time, and applies
the same validation, digest, metrics, freshness, and summary decoders as point
reads. Its semantic FTS check builds one complete, contentless, memory-only TEMP
expected index from canonical rows in bounded keyset reads under one private
savepoint. It streams exact row-vocabulary equality, then partitions the
bidirectional term-instance comparison at 1,000,000 occurrences per side or one
oversized term; docsize is compared separately in both directions. The complete
expected index remains corpus-sized, so total memory is not constant, but no
comparison state spills to disk. Incomplete capture evidence produces an
`ok: true` warning; failed health remains a failure. Direct
out-of-band SQLite edits are unsupported; neither the clean fast open nor
certified recovery replaces doctor as the explicit immutable full-library check.
Index schema 2 adds one
strict, foreign-keyed metrics row per canonical session. Replacement writes it
atomically with the document; migration backfills schema-1 libraries; health
requires exact one-to-one coverage and semantic equality. Index schema 3 adds
the transaction-bound recovery receipt described above; it is operational proof,
not retained canonical evidence.

Interactive doctor progress is a fixed best-effort stderr presentation owned by
the CLI. Redirected stderr stays quiet for normal success and failed-check
reports. `SESSIONS_DOCTOR_TIMINGS=1` adds one aggregate allowlisted stderr record
from the composition root on success or failure. Progress and timing observers
cannot affect check order, health decisions, stdout, or exit codes. Doctor does
not install cooperative signal handling around synchronous SQLite work; normal
process signals stop the immutable audit without leaving the library dirty.

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

`src/domain/session-query.ts` owns validated immutable filters, term mode,
activity bounds, limits, context, cursors, pages, hits, matched terms, roots, and
support values. `src/domain/session-manifest.ts` owns the workspace-free filter,
fixed order and 10,000-revision complete-result bound, selection, revisions, and
counts. `src/domain/session-document-metrics.ts` derives occurrence-based
canonical counts and logical transcript UTF-8 bytes. `src/domain/session-capture-scope.ts` owns the immutable
aggregate, filter-name assessment, partitions, and status invariants.
`src/domain/session-lineage.ts` owns the
iterative provider-neutral root policy. `src/application/ports/session-query.ts`
defines the minimal list/search/entries/manifest repository; services own
defaults and fresh-library behavior.

SQLite owns literal all/any FTS translation, parameterized filter SQL,
deterministic rank/order, activity filtering over `updatedAt` with `createdAt`
fallback, bounded context assembly, query-wide counts, and cursor encoding.
The shared capture-scope reader uses registered-source and tracking columns only,
reports applicable source coverage even for a no-hit page, and names canonical
metadata, entry, and text filters it cannot assess for unindexed sessions.
Search ranks compact coordinates first, keeps the extra rank-only row used for
pagination, and hydrates text, digest, and snippets only for the selected page.
Snippet markers are checked against those selected canonical texts and retried
on collision, so search does not scan or hydrate the rest of the library.
`any` mode derives exact per-hit terms with candidate-local probes after page
selection. One query-scoped root resolver serves support plus list/search/entries
attribution. Support remains exact and query-wide rather than being inferred from the page.
`fts-projection.ts` is the shared bootstrap/repair definition. These modules do
not import adapters. Adapters supply only source-supported lineage and observed
tool evidence; they cannot decide roots, counts, filters, ranking, or presentation.

Capture scope is page- or manifest-cohort-level evidence availability, not
another search-support unit. It does not classify tracking-only rows against
unassessed filters and never manufactures a retained match. Root attribution is
query output only. It may point outside current filters and does not enter
canonical documents, digests, show, or export. Manifest changes no provider
adapter, canonical document projection, or FTS index. It selects
and bounds canonical identities before left-joining metrics, so a missing
derivative fails instead of silently omitting a retained revision. It orders by
binary canonical identity and never uses cursors or per-session hydration.

The application layer performs title/transcript selection once, before choosing
a human or machine renderer. Show keeps its existing focus/default behavior, and
show/export may select one paired inclusive range of at most 200 entries. Invalid
or out-of-document ranges are never clamped. Every bounded selection then uses
the same relation/segment/text limits. The full canonical document is still read
and verified first, and its digest identifies ranged output. Export full mode
removes presentation selection only; it does not broaden the public projection. The CLI
maps these safe values and transcript-free manifest revisions field by field
into closed schema-1 DTOs, recursively
validates them, encodes the whole result, and applies the exact 16 MiB bound
before stdout. JSONL is independently attributable but is not a direct SQLite
stream. Format never enters list/search/entries query fingerprints; manifest has
no format-neutral continuation state because it never pages.

## Build

Source uses explicit `.ts` imports and erasable TypeScript. `tsconfig.build.json`
compiles only `src/` into `dist/`, rewrites relative extensions to `.js`, and
emits source maps. The package exposes no library API; published consumers execute
`dist/bin/sessions.js`. The package also ships the exact ten-file
`skills/sessions/` tree for copying into an agent host; it adds no runtime
dependency to the CLI.

Release Please owns the root version, changelog, and `vX.Y.Z` tags. The release
workflow qualifies one exact tarball with the full gate and Linux/macOS/Windows
install smokes before a protected OIDC publish job can receive
`id-token: write`. The checked-in workflow is inert for publication until
maintainers configure the GitHub App, protected environment, npm package, and
trusted publisher. See [releasing](releasing.md).
