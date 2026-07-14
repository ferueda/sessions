# Privacy contract

- Status: accepted V1 contract; current implementation called out explicitly
- Last updated: 2026-07-14

Sessions handles sensitive local history. Privacy behavior is a product contract, not a best-effort feature.

## Current implementation

The current CLI exposes help, version, `doctor`, and `paths`. `paths` reports only Sessions-owned index locations and existing state. `doctor` checks Node.js, probes SQLite FTS5 and its per-table secure-delete capability in memory, and inspects the existing index state. For a ready index it uses an immutable snapshot to check integrity, foreign keys, FTS structure/content/security, run records, and sanitized writer-lease state. An uninitialized index is healthy. Neither command creates directories, initializes or migrates a database, locates provider histories, uses telemetry, or accesses the network.

The internal provider-neutral indexing service, coordinated writer lifecycle, canonical repository, and clear maintenance are implemented and exercised by tests. The indexing service admits complete source discovery before writes, preserves last-good documents after failed refreshes, reconciles deletions only after a complete exact-source scan, and returns bounded typed diagnostics without transcript content or raw errors. The repository stores validated provider-neutral session documents, freshness state, bounded run diagnostics, and derived FTS data.

Schema version 3 stores one expiring generation lease for internal `index` or `clear` ownership. Each repository mutation fences stale owners inside its write transaction; takeover marks abandoned active runs interrupted. Clear maintenance removes only the known database, WAL, and SHM paths after safety checks, never provider files or the cache directory recursively. There are no source adapters or public index/clear commands, so the current CLI still cannot populate or clear transcript content.

Those cache, complete-scan deletion, and whole-index clear semantics describe the
implemented pre-public M4 baseline only. [ADR 0007](decisions/0007-retain-a-durable-canonical-library.md)
replaces them before M5 exposes a writer: canonical snapshots become durable user
data, complete-scan absence becomes non-destructive source state, and deletion is
explicit.

## V1 promises

- Indexing starts only when the user runs `sessions index`.
- A successful index creates an independent durable local copy of the latest
  successfully normalized canonical snapshot. Provider deletion or expiry does
  not delete that copy.
- Cursor, Codex, and future source histories are read-only inputs.
- Index, list, search, show, export, paths, and doctor operations require no network access and emit no telemetry.
- List, search, show, and export use the canonical library after indexing; they do not silently reopen mutable source histories.
- A complete scan can mark a retained session missing. Unavailable, unreadable,
  malformed, or incomplete discovery never proves absence, and no source state
  automatically deletes canonical content.
- No TTL or automatic pruning removes retained sessions. Only an explicit
  `sessions forget` or `sessions data clear` invocation deletes them.
- Sessions stores normalized content required for faithful results, not entire raw provider payloads.
- The Codex adapter may briefly stage raw `state_5.sqlite` database/WAL bytes—not
  rollout transcripts—beneath the exact private Sessions-owned `.scratch`
  subtree to read active WAL state without opening provider SQLite. Normal
  completion removes them before discovery returns. A crash can retain them
  until the next leased index sweep or explicit data clear.
- Unsupported non-text content retains only ordered omission class/provenance.
  Sessions does not separately open or fetch referenced resources and does not
  persist media bytes, data URLs, remote URLs, or local attachment paths.
- `sessions paths` explains the owned library location without printing transcript content. Registered adapters will later add sanitized source roots.
- Rebuilding FTS/query projections preserves canonical content. `sessions forget`
  removes one selected snapshot/tracking record and its identity-bearing
  historical run-item details; aggregate run diagnostics and incoming relation
  references owned by other snapshots remain. `sessions data clear` removes only
  the known Sessions-owned library database/sidecars and exact ephemeral scratch
  subtree.
- Portable export excludes diagnostic source locators, provider roots, source
  metadata, and local workspace paths by default. Transcript text itself is not
  secret- or path-redacted and must be reviewed before it leaves the machine.
- No project, skill, provider configuration, or source transcript is automatically edited from analysis output.

## Local state

### Current M4 path

The current read-only `paths` command resolves its pre-M5 cache directory as follows:

- Linux: `$XDG_CACHE_HOME/sessions` when `XDG_CACHE_HOME` is absolute; otherwise `$HOME/.cache/sessions`.
- macOS: `$HOME/Library/Caches/sessions`.
- Windows: `%LOCALAPPDATA%\sessions`; a missing or relative `LOCALAPPDATA` is an error.

An absolute `SESSIONS_CACHE_DIR` replaces the full owned directory path; Sessions does not append another `sessions` leaf. The database is `index.sqlite3`, with known `index.sqlite3-wal` and `index.sqlite3-shm` sidecar paths. This state is separate from the legacy Harness JSONL cache and is never reused or automatically migrated. `sessions paths` can inspect the location before it exists without creating it.

### Accepted V1 path

M5 moves the durable canonical library to platform application data:

- Linux: `$XDG_DATA_HOME/sessions` when `XDG_DATA_HOME` is absolute; otherwise
  `$HOME/.local/share/sessions`.
- macOS: `$HOME/Library/Application Support/sessions`.
- Windows: `%LOCALAPPDATA%\sessions`; a missing or relative `LOCALAPPDATA` is an
  error.

An absolute `SESSIONS_DATA_DIR` replaces the full owned directory path. The
database is `sessions.sqlite3`, with known `sessions.sqlite3-wal` and
`sessions.sqlite3-shm` sidecars. The only ephemeral workspace is the exact
`.scratch` child. M5 does not silently reuse, import, or delete the
pre-public cache database or legacy Harness JSONL cache. `sessions paths` reports
the accepted library and scratch locations without creating either.

When the internal writer is explicitly opened, it creates owned POSIX directories with mode `0700` and constrains the database, WAL, SHM, and scratch files to `0600` where applicable. On Windows, default state remains inside the current user's local profile and relies on platform ACLs. The writer enables foreign keys, WAL, a five-second busy timeout, and SQLite core `secure_delete`. Its ordered, checksummed migrations run transactionally and refuse incompatible or newer history. Immutable readers and doctor refuse WAL recovery state; the coordinated writer may recover valid SQLite WAL state before acquiring its lease. Once canonical data is durable, migration and repair guidance must preserve a recoverable prior database rather than assuming provider reindex is possible.

Scratch has a separate transient lifecycle. Only an index writer holding the
exclusive lease may sweep/create it; Codex uses random children and removes each
attempt in `finally`; writer close attempts root removal before lease release and
surfaces cleanup failure while still closing/releasing safely. Probe, paths,
doctor, and library readers never create it. The raw state copy can contain
provider bookkeeping and unrelated rows beyond the normalized thread fields,
including IDs, titles, and workspaces, so crash residue has the same local-at-
rest limitations as the canonical database even though it is not retained
product data.

Canonical sessions and capture state are durable user data. FTS/query projections
and bounded operational diagnostics are rebuildable derived state even when they
share the same SQLite database. Projection repair never deletes canonical rows.
Current M4 all-data clear is non-migrating. Before M5 exposes it publicly, valid
lease-bearing schemas 3 and 4 must acquire or safely take over their existing
persistent clear lease before close/unlink; schema 3 is not migrated merely to
delete it and cannot use the legacy direct-unlink branch. Clear remains
only-owned-state scoped: under active heartbeat it removes the exact scratch
subtree without following symlinks, then refreshes/asserts ownership,
checkpoints, closes without release, and removes only the revalidated database/
WAL/SHM paths. Beginning scratch deletion is destructive intent; when scratch is
absent, intent begins at the final renewal/checkpoint immediately before close.
Later failure leaves clear ownership for clear-only recovery. An orphan scratch root
without its lease-bearing database is recovery-required and is not removed
without coordination. Missing state is success; unsafe/unrecognized state, a
live writer, and partial deletion fail with sanitized typed errors.
Forget/data-clear never alters provider histories.

## Deletion limitations

Forget is scoped deletion, not global erasure by value. It removes the selected
session's stored transcript and owned evidence, but it does not rewrite another
retained session merely because that session has a canonical relation pointing
to the forgotten identity or contains the same text. Reindex can capture a
still-present provider session again. Use explicit data clear to remove the whole
Sessions-owned library.

The writer enables SQLite core `secure_delete`. It also enables FTS5's persistent per-table secure-delete setting on the canonical content index when the runtime supports it; a supported runtime that cannot configure the real table fails writer opening. Doctor reports runtime support using an in-memory capability probe.

These settings reduce recoverable deleted content inside SQLite pages; they do not provide encryption, guaranteed physical overwrite, or forensic secure erasure. Filesystems, backups, snapshots, swap, and storage hardware can retain copies.

Users requiring stronger protection should use operating-system full-disk encryption and manage backups according to their threat model.

## Threat boundaries

Sessions protects against accidental mutation, unexpected network transfer, overly broad package contents, and permissive local state within its control. It does not protect against another process running as the same user, a compromised provider, malware, an already-compromised package manager, or privileged filesystem access.

Source formats can contain prompt injection or untrusted tool output. Sessions treats transcript text as data. The CLI never executes indexed or exported content. Portable Markdown frames prior instructions as historical data, but Sessions cannot guarantee how a destination system interprets user-delivered content.

## Reporting

Use the private process in [SECURITY.md](../SECURITY.md). Never attach a real provider database or unredacted transcript unless a secure channel and minimum necessary scope have been agreed.
