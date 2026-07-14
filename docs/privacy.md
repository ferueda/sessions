# Privacy contract

- Status: accepted V1 contract; current implementation called out explicitly
- Last updated: 2026-07-14

Sessions handles sensitive local history. Privacy behavior is a product contract, not a best-effort feature.

## Current implementation

The current CLI exposes help, version, `doctor`, and `paths`. `paths` reports only Sessions-owned index locations and existing state. `doctor` checks Node.js, probes SQLite FTS5 and its per-table secure-delete capability in memory, and inspects the existing index state. For a ready index it uses an immutable snapshot to check integrity, foreign keys, FTS structure/content/security, run records, and sanitized writer-lease state. An uninitialized index is healthy. Neither command creates directories, initializes or migrates a database, locates provider histories, uses telemetry, or accesses the network.

The internal provider-neutral indexing service, coordinated writer lifecycle, canonical repository, and clear maintenance are implemented and exercised by tests. The indexing service admits complete source discovery before writes, preserves last-good documents after failed refreshes, reconciles deletions only after a complete exact-source scan, and returns bounded typed diagnostics without transcript content or raw errors. The repository stores validated provider-neutral session documents, freshness state, bounded run diagnostics, and derived FTS data.

Schema version 3 stores one expiring generation lease for internal `index` or `clear` ownership. Each repository mutation fences stale owners inside its write transaction; takeover marks abandoned active runs interrupted. Clear maintenance removes only the known database, WAL, and SHM paths after safety checks, never provider files or the cache directory recursively. There are no source adapters or public index/clear commands, so the current CLI still cannot populate or clear transcript content.

## V1 promises

- Indexing starts only when the user runs `sessions index`.
- Cursor, Codex, and future source histories are read-only inputs.
- Index, list, search, show, export, paths, and doctor operations require no network access and emit no telemetry.
- List, search, show, and export use the canonical index after indexing; they do not silently reopen mutable source histories.
- Sessions stores normalized content required for faithful results, not entire raw provider payloads.
- Unsupported non-text content retains only ordered omission class/provenance.
  Sessions does not separately open or fetch referenced resources and does not
  persist media bytes, data URLs, remote URLs, or local attachment paths.
- `sessions paths` explains the owned index location without printing transcript content. Registered adapters will later add sanitized source roots.
- `sessions index clear` removes Sessions-owned index files only.
- No project, skill, provider configuration, or source transcript is automatically edited from analysis output.

## Local state

Sessions resolves its owned state directory as follows:

- Linux: `$XDG_CACHE_HOME/sessions` when `XDG_CACHE_HOME` is absolute; otherwise `$HOME/.cache/sessions`.
- macOS: `$HOME/Library/Caches/sessions`.
- Windows: `%LOCALAPPDATA%\sessions`; a missing or relative `LOCALAPPDATA` is an error.

An absolute `SESSIONS_CACHE_DIR` replaces the full owned directory path; Sessions does not append another `sessions` leaf. The database is `index.sqlite3`, with known `index.sqlite3-wal` and `index.sqlite3-shm` sidecar paths. This state is separate from the legacy Harness JSONL cache and is never reused or automatically migrated. `sessions paths` can inspect the location before it exists without creating it.

When the internal writer is explicitly opened, it creates owned POSIX directories with mode `0700` and constrains the database, WAL, and SHM files to `0600`. On Windows, default state remains inside the current user's local profile and relies on platform ACLs. The writer enables foreign keys, WAL, a five-second busy timeout, and SQLite core `secure_delete`. Its ordered, checksummed migrations run transactionally and refuse incompatible or newer history. Immutable readers and doctor refuse WAL recovery state; the coordinated writer may recover valid SQLite WAL state before acquiring its lease.

The index is rebuildable derived data. Internal clear behavior is non-migrating and only-owned-file scoped. Missing state is success; unsafe paths, recovery sidecars for non-current state, a live writer, and partial deletion fail with sanitized typed errors. Clearing never alters provider histories.

## Deletion limitations

The writer enables SQLite core `secure_delete`. It also enables FTS5's persistent per-table secure-delete setting on the canonical content index when the runtime supports it; a supported runtime that cannot configure the real table fails writer opening. Doctor reports runtime support using an in-memory capability probe.

These settings reduce recoverable deleted content inside SQLite pages; they do not provide encryption, guaranteed physical overwrite, or forensic secure erasure. Filesystems, backups, snapshots, swap, and storage hardware can retain copies.

Users requiring stronger protection should use operating-system full-disk encryption and manage backups according to their threat model.

## Threat boundaries

Sessions protects against accidental mutation, unexpected network transfer, overly broad package contents, and permissive local state within its control. It does not protect against another process running as the same user, a compromised provider, malware, an already-compromised package manager, or privileged filesystem access.

Source formats can contain prompt injection or untrusted tool output. Sessions treats transcript text as data. The CLI never executes indexed content.

## Reporting

Use the private process in [SECURITY.md](../SECURITY.md). Never attach a real provider database or unredacted transcript unless a secure channel and minimum necessary scope have been agreed.
