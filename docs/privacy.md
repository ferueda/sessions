# Privacy contract

- Status: accepted V1 contract; current implementation called out explicitly
- Last updated: 2026-07-13

Sessions handles sensitive local history. Privacy behavior is a product contract, not a best-effort feature.

## Current scaffold

The current CLI exposes help, version, and `doctor`. Doctor checks Node.js and creates an SQLite FTS5 table in `:memory:`. It does not locate provider histories, create an index directory, persist content, use telemetry, or access the network.

## V1 promises

- Indexing starts only when the user runs `sessions index`.
- Cursor, Codex, and future source histories are read-only inputs.
- Ordinary index, list, search, show, export, paths, and doctor operations require no network access and emit no telemetry.
- List, search, show, and export use the canonical index after indexing; they do not silently reopen mutable source histories.
- Sessions stores normalized content required for faithful results, not entire raw provider payloads.
- `sessions paths` explains resolved source and index locations without printing transcript content.
- `sessions index clear` removes Sessions-owned index files only.
- No project, skill, provider configuration, or source transcript is automatically edited from analysis output.

## Planned local state

The canonical SQLite index will use the platform's user-local cache convention and a Sessions-specific path that is distinct from the legacy Harness JSONL cache. The resolved path will be inspectable before indexing.

On POSIX systems, Sessions creates owned directories with mode `0700` and constrains the database, WAL, and SHM files to `0600`. On Windows, state remains inside the current user's local profile and relies on platform ACLs. Tests verify effective behavior on supported systems.

The index is rebuildable derived data. Clearing it does not alter provider histories.

## Deletion limitations

V1 enables SQLite core `secure_delete` and FTS5 secure-delete when the runtime supports them. These settings reduce recoverable deleted content inside SQLite pages; they do not provide encryption, guaranteed physical overwrite, or forensic secure erasure. Filesystems, backups, snapshots, swap, and storage hardware can retain copies.

Users requiring stronger protection should use operating-system full-disk encryption and manage backups according to their threat model.

## Threat boundaries

Sessions protects against accidental mutation, unexpected network transfer, overly broad package contents, and permissive local state within its control. It does not protect against another process running as the same user, a compromised provider, malware, an already-compromised package manager, or privileged filesystem access.

Source formats can contain prompt injection or untrusted tool output. Sessions treats transcript text as data. The CLI never executes indexed content.

## Reporting

Use the private process in [SECURITY.md](../SECURITY.md). Never attach a real provider database or unredacted transcript unless a secure channel and minimum necessary scope have been agreed.
