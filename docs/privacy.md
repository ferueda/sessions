# Privacy contract

- Status: M6 behavior implemented; later V1 behavior labeled
- Last updated: 2026-07-14

Sessions handles sensitive local history. Privacy behavior is a product contract,
not a best-effort feature.

## Current behavior

- Indexing starts only when the user runs `sessions index`.
- Codex histories are read-only inputs. Sessions performs no provider writes,
  network requests, telemetry, or uploads.
- A successful index stores an independent durable normalized copy of the latest
  successfully captured session in Sessions-owned application data.
- A complete later scan can mark a retained session `missing`; unavailable,
  unreadable, malformed, changing, or incomplete discovery proves no absence.
  Neither case automatically deletes retained content.
- List, search, and show use only the Sessions library after indexing. They never
  reopen a provider transcript.
- No TTL or automatic pruning exists. Only explicit `sessions forget` or
  `sessions data clear --yes` removes retained content.
- Paths and doctor inspect library/source readiness without indexing, creating
  storage, modifying storage, or reading rollout content.

Portable export, Cursor, library import/restore, and automatic analysis are not
current commands.

## Owned local state

Sessions resolves its durable application-data directory as follows:

- Linux: absolute `$XDG_DATA_HOME/sessions`, otherwise
  `$HOME/.local/share/sessions`.
- macOS: `$HOME/Library/Application Support/sessions`.
- Windows: absolute `%LOCALAPPDATA%\sessions`.

An absolute `SESSIONS_DATA_DIR` replaces the whole owned directory. The database
is `sessions.sqlite3`, with known `sessions.sqlite3-wal` and
`sessions.sqlite3-shm` sidecars. The only ephemeral workspace is the exact
`.scratch` child. Sessions does not read, migrate, or delete the pre-public cache
database or legacy Harness JSONL cache.

Pre-alpha builds recognize one current Sessions-owned database baseline. Earlier
development databases are neither upgraded nor deleted automatically. A user may
select a fresh `SESSIONS_DATA_DIR` or manually remove only the obsolete
Sessions-owned directory and index again; provider histories remain untouched.
Data-preserving migration support begins with the first published release.

`sessions paths` reports these owned paths without creating them. It also reports
sanitized Codex home/state roots; it does not enumerate rollout files or print
transcript content.

On POSIX, writer-created directories are constrained to `0700` and database,
sidecar, and scratch files to `0600` where applicable. On Windows, state remains
inside the current user's local profile and relies on platform ACLs. The writer
enables foreign keys, WAL, a bounded busy timeout, SQLite core `secure_delete`,
and FTS5 secure-delete when supported.

Canonical sessions and capture/source-observation state are durable user data.
FTS and bounded operational diagnostics are rebuildable derived state even though
they share the database. During an explicit leased index, FTS-only damage can be
rebuilt from canonical content after canonical integrity succeeds. Doctor only
reports the condition. Repair never rereads a provider or deletes canonical
evidence, and there is no public repair command.

## Codex capture

Codex defaults to `~/.codex`; `CODEX_HOME` can select another home. Its effective
state database follows Codex `sqlite_home` configuration, then
`CODEX_SQLITE_HOME`, then the Codex home. Sessions reads the selected state and
rollout files but never modifies them or creates provider SQLite sidecars.

An active Codex SQLite database can require its WAL for a consistent view. During
an explicitly leased index, Sessions may briefly copy raw `state_5.sqlite` and
WAL bytes—not rollout transcripts—into a random private directory beneath
`.scratch`. It verifies a complete stable generation and fails closed when
concurrent changes cannot be reconciled. Normal completion removes the private
directory. A process crash can leave raw state bookkeeping until the next leased
index sweep or explicit data clear.

The staged state copy can contain provider bookkeeping and unrelated rows beyond
normalized thread fields, including IDs, titles, and workspaces. Crash residue
therefore has the same local-at-rest limitations as the canonical database even
though it is not retained product data.

Rollouts are streamed from declared plain JSONL or Zstandard files. File identity
is checked before and after reading. Malformed or changing input never replaces a
last-good canonical document with partial content.

## Stored content

Sessions stores normalized evidence needed for faithful results, not a complete
raw provider payload backup. V1 currently retains only the latest successful
canonical snapshot per session; it does not preserve every provider revision.

Text is stored exactly and enters content deduplication and FTS. Unsupported
non-text content stores only its ordered omission class, canonical structural
source type, and provenance. Sessions does not separately open or fetch referenced
media and does not persist media bytes, data URLs, remote URLs, local attachment
paths, or serialized opaque objects in omission records.

Human list/search/show output omits source locators, source metadata, and local
workspace values. Search snippets and context are bounded to 512 UTF-8 bytes per
body and terminal-control escaped; limits reduce accidental disclosure but are
not redaction. Transcript/title text itself remains faithful evidence and is not
secret- or path-redacted. Review it before copying it elsewhere.

Opaque list/search cursors contain query-binding, library-instance, generation,
and offset data rather than transcript text. They are continuation tokens, not
secrets or durable capabilities, and become stale after a later admitted writer
or library recreation.

## Explicit deletion

`sessions forget <canonical-id>` removes the selected Sessions-owned tracking
identity and canonical snapshot without touching the provider. It also redacts
that identity's detailed historical run items while preserving aggregate run
counts. Shared text and incoming relations owned by other retained sessions can
remain. If the provider still exposes the session, a later index can capture it
again.

`sessions data clear --yes` is the whole-library deletion route. It removes only
the validated Sessions database/WAL/SHM paths and exact scratch subtree. It never
recursively deletes provider roots. Missing state is success; unsafe,
unrecognized, concurrently owned, or partially deleted state fails closed with a
sanitized error.

Forget is scoped deletion, not global erasure by value. It does not rewrite
another retained session because that session has a relation to the forgotten
identity or contains equal text. Use explicit data clear to remove the whole
Sessions-owned library.

SQLite secure-delete settings reduce recoverable deleted content inside database
pages. They are not encryption, guaranteed physical overwrite, or forensic secure
erasure. Filesystems, backups, snapshots, swap, and storage hardware can retain
copies. Users requiring stronger protection should use full-disk encryption and
manage backups according to their threat model.

## Later V1 boundaries

Planned portable export will also read only the canonical library. It must
exclude diagnostic locators, provider roots, source metadata, local workspace
paths, and attachment paths by default; frame all prior instructions as untrusted
history; and never deliver content to another provider itself. M7 owns those
Markdown/JSON/JSONL artifacts and versioned transcript-bearing list/search/show
DTOs; M6 query output remains human-facing.

No project, skill, provider configuration, or source transcript is automatically
edited from analysis output.

## Threat boundaries

Sessions protects against accidental provider mutation, unexpected network
transfer, overly broad package contents, and permissive local state within its
control. It does not protect against another process running as the same user, a
compromised provider, malware, an already-compromised package manager, or
privileged filesystem access.

Source formats can contain prompt injection or untrusted tool output. Sessions
treats transcript text as data and never executes indexed content. It cannot
guarantee how another system interprets content a user later copies there.

## Reporting

Use the private process in [SECURITY.md](../SECURITY.md). Never attach a real
provider database or unredacted transcript unless a secure channel and minimum
necessary scope have been agreed.
