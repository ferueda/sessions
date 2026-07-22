# Maintenance

## Purpose

Maintenance changes only the Sessions-owned library. It never reads, changes,
or deletes provider history.

## Writer coordination

`index`, `forget`, `repair`, `compact`, and `clear` share one renewable writer
lease. The lease binds a generation, purpose, and private owner token. Each
write transaction checks that exact owner; an expired takeover raises the
generation and fences the old writer. A live owner makes other mutations fail
as `Session library is busy`.

An immediate transaction may renew the same owner at entry and exit even if its
work crosses the lease expiry, because SQLite already excludes another writer.
Failure rolls back both that transaction's work and lease renewal. An expired
`clear` lease is reserved for another clear so an interrupted destructive
operation cannot be followed by a different writer.

The schema-3 index-generation receipt certifies only supported `index`
transactions. Forget, orphan repair, compaction, and clear do not initialize or
advance it. Their free, live, expired, or newer-generation maintenance lease
state makes any older receipt ineligible, so the next index writer uses the
complete canonical, foreign-key, and FTS validation/repair path before it can
create new proof. A receipt never changes clear-only recovery precedence or
turns a live lease into recoverable ownership.

## Operations

| Command                 | Behavior                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `forget <canonical-id>` | Deletes one retained session and its owned evidence. It keeps shared text, incoming relations, aggregate run facts, and unrelated orphans.             |
| `data repair-orphans`   | Scans to completion in fixed internal batches and deletes only content with no occurrence and a matching FTS row. It reports logical rows/UTF-8 bytes. |
| `data compact`          | Checkpoints WAL and reclaims whole free pages in bounded incremental-vacuum transactions. It deletes no canonical rows.                                |
| `data clear --yes`      | Removes the validated database, WAL, SHM, and exact scratch subtree. File identity is checked before removal.                                          |

All operations validate owned paths and recognized library state before
mutation. Forget is idempotent. Repair and compaction make committed batch
progress durable; if a later batch or cleanup fails, they emit no success report
and a fresh run is safe. Candidate checks and trigger failures roll back the
active repair batch. Clear retains its clear-only recovery intent until known
files are safely removed.

FTS repair is not a public maintenance command. It belongs to an explicit index
writer and rebuilds derived search state only after canonical data is healthy.

## Guarantees and cost

- These maintenance operations are explicit and provider-free. None runs during
  normal reads or per-session replacement.
- Unsafe paths, incompatible state, corruption, concurrent file changes, and
  lost lease ownership fail closed.
- Orphan repair uses bounded transactions but may scan the full content table.
- Compaction may take several batches and reclaims only free whole pages. It is
  not full `VACUUM`, does not repack partial pages, and may reclaim zero bytes.
- Logical deletion, SQLite secure-delete settings, and compaction do not promise
  forensic erasure from backups, snapshots, or storage media.

## Code and tests

- Port and composition: `src/application/ports/index-maintenance.ts` and
  `src/infrastructure/sqlite/index-maintenance.ts`
- Writer lease: `src/infrastructure/sqlite/writer-lease.ts`
- Index-only recovery proof:
  `src/infrastructure/sqlite/writer-recovery-receipt.ts`
- Operations: `src/infrastructure/sqlite/sqlite-index-forget.ts`,
  `src/infrastructure/sqlite/sqlite-index-repair-orphans.ts`, and
  `src/infrastructure/sqlite/sqlite-index-compact.ts`
- Proof: `test/infrastructure/sqlite-writer-coordination.test.ts`,
  `test/infrastructure/index-maintenance-forget.test.ts`,
  `test/infrastructure/index-maintenance-repair-orphans.test.ts`,
  `test/infrastructure/index-maintenance-compact.test.ts`, and
  `test/infrastructure/index-maintenance.test.ts`
