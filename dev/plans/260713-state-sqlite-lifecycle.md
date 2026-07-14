# Add safe local state and SQLite lifecycle

## Goal

Implement M2 from the V1 roadmap: Sessions resolves and explains its own
platform-local index paths, inspects state without mutation, and can internally
open a protected SQLite writer with recoverable forward migrations. Ship only
`sessions paths`; the writer remains unavailable to public commands until a real
source is registered. Provider histories and the legacy Harness cache remain
outside this lifecycle.

Acceptance requires versioned human/JSON path reports, healthy uninitialized
doctor guidance, no files from `paths` or `doctor`, restrictive local modes,
checksummed transactional migrations, newer-schema refusal, required SQLite
pragmas, and honest FTS5 secure-delete capability reporting.

## Changes

1. `src/domain/index-state.ts`, `src/application/ports/index-lifecycle.ts`, and
   `src/application/get-paths.ts` — model `uninitialized`, `ready`,
   `migration-required`, `newer-schema`, `incompatible`, `recovery-required`,
   and `unsafe` states. Keep inspection and writer capabilities separate so
   `getPaths` and doctor cannot initialize state. Return a schema-versioned
   provider-neutral report containing only the owned directory,
   `index.sqlite3`, known WAL/SHM paths, initialization state, and schema
   compatibility.

2. `src/infrastructure/state/paths.ts` — resolve the owned `sessions` directory
   under Linux XDG cache, macOS `Library/Caches`, or Windows `LOCALAPPDATA`.
   `SESSIONS_CACHE_DIR` selects the owned directory exactly and must be absolute;
   a relative Linux XDG value falls back to `~/.cache`; missing Windows
   `LOCALAPPDATA` is an operational error. Keep resolution pure through injected
   platform, environment, and home values.

3. `src/infrastructure/sqlite/migrations.ts` and
   `src/infrastructure/sqlite/migrations/0001-bootstrap.ts` — add a contiguous
   TypeScript migration catalog and `sessions_schema_migrations` metadata only;
   M3 owns canonical content tables. Hash exact version/name/SQL bytes with
   versioned SHA-256, require applied history to be an exact catalog prefix, and
   run each pending migration under `BEGIN IMMEDIATE`. Recheck after acquiring
   the write lock, roll back the failed migration, retain prior releases, and
   refuse unknown, changed, gapped, or newer history.

4. `src/infrastructure/sqlite/database.ts` and
   `src/infrastructure/sqlite/permissions.ts` — implement guarded immutable
   inspection when no sidecars exist; report sidecars as active/recovery state
   rather than opening them. Snapshot/recheck the database around inspection to
   reject concurrent change. The explicit writer creates only known owned paths,
   rejects symlinks and unexpected file types, uses a 5-second timeout, foreign
   keys, WAL, defensive mode, and core `secure_delete`, and constrains POSIX
   directories to `0700` and DB/WAL/SHM files to `0600`. Windows relies on the
   current profile's local ACLs.

5. `src/infrastructure/sqlite/sqlite-diagnostic.ts` and a focused FTS helper —
   probe FTS5 plus its per-table secure-delete command in memory. Treat missing
   FTS5 as failure; report unsupported FTS secure-delete honestly without calling
   it encryption. M3 will apply the helper to the first persistent FTS table.

6. `src/cli/`, `src/application/run-doctor.ts`, and `src/bin/sessions.ts` — add
   `paths [--format human|json]`, inject only the read capability, and append a
   stable `index-state` doctor check. Successfully reported incompatible state
   remains a `paths` result with exit 0; doctor maps it to a failed check.
   Uninitialized state passes with neutral guidance because `sessions index` is
   not public yet.

7. `test/` and smoke scripts — cover the three OS path matrices, override and
   missing environment behavior, state rendering/streams/help, no-persistence
   subprocesses, immutable inspection, fresh/reopen migration, ordered releases,
   injected rollback/retry, checksum and newer-schema refusal, pragmas, FTS5,
   effective POSIX modes, and unchanged neighboring provider fixtures. Run dist
   and packed-install doctor/paths commands against isolated absent overrides.

8. Current-behavior docs and `dev/plans/README.md` — document the shipped paths
   command, persistent-state lifecycle, current doctor checks, privacy limits,
   code map, and verification seams. Remove this executor plan after merge;
   retain the program roadmap.

## Verify

- `pnpm vitest run test/infrastructure/state-paths.test.ts test/application/get-paths.test.ts test/infrastructure/sqlite-lifecycle.test.ts test/cli.test.ts test/doctor-no-persistence.test.ts test/paths-no-persistence.test.ts`
- `pnpm check`

## Boundaries

- No canonical session tables or repository behavior (M3).
- No indexing/reconciliation or public `sessions index` command (M4/M5).
- No provider discovery, source roots, Harness cache migration, or provider writes.
- Read-only inspection never uses a plain WAL-mode SQLite connection because it
  can create sidecar files.
