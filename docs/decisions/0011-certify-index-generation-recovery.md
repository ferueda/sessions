# 0011 — Certify index-generation recovery

- Status: Accepted
- Date: 2026-07-21
- Extends: [ADR 0007](0007-retain-a-durable-canonical-library.md)

## Context

An index writer already commits each durable operation atomically and checks its
local canonical, tracking, run, digest, and affected-FTS postconditions before
commit. A process crash can therefore leave a valid WAL-recovered library and an
expired index lease even though normal close never published the stronger
stat-bound clean proof. Treating every such generation as unproven requires a
whole-library canonical, foreign-key, FTS content, and FTS semantic scan before
the next index can begin. That cost scales with retained history rather than the
new work.

A sampled scan would reduce cost by weakening the integrity contract. Resuming
the abandoned run would also confuse committed evidence with provider state that
must be discovered again. Sessions instead needs durable proof that every
supported index mutation stopped only at a checked transaction boundary, while
keeping full validation as the fallback whenever that proof is not exact.

## Decision

Storage schema 3 adds one strict singleton
`sessions_index_generation_receipt` row. Receipt format 1 contains only the
certified writer generation, storage schema version, SQLite schema cookie, and a
monotonically increasing safe-integer operation sequence. It has no timestamp,
source, session, path, fingerprint, content hash, transcript, lease token, or
timing value. The schema-2-to-3 migration preserves canonical and operational
state and does not backfill a receipt.

The receipt is operational proof, not canonical evidence. The receipt module is
its only decoder and mutator. After writer setup succeeds, the exact live index
owner creates sequence zero in a leased transaction. Every supported durable
index mutation then performs its existing local postconditions and advances the
sequence once in the same immediate leased transaction. A failure rolls back
both the operation and the sequence. Heartbeat renewal is coordination-only and
does not advance the receipt.

### Writer-open state machine

Writer acquisition inspects the prior receipt while the old lease row is locked.
It may retain a typed certified-recovery candidate only when all of these facts
hold:

1. the prior lease is expired, has purpose `index`, and names the receipt's exact
   generation;
2. the receipt uses the current format and storage schema version and names the
   pre-acquisition SQLite schema cookie;
3. no migration is pending or applied during this open;
4. the library, migration, and lease catalog remain valid after ordinary SQLite
   WAL recovery; and
5. the constant-size FTS table, index, and trigger structure is valid.

The acquisition transaction interrupts abandoned active runs, advances to the
new exact owner, and clears the old receipt before commit. The new owner rechecks
the candidate after migration processing. It then selects exactly one writer
open mode in this order:

| Prior evidence or state                                                                                                                             | Result                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Matching clean seal and stat-bound post-close proof on a ready, sidecar-free, current-schema library                                                | `fast`; use bounded catalog and FTS structure checks                                                                          |
| Exact expired index lease and matching receipt, with no migration and valid bounded structure checks                                                | `certified-recovery`; interrupt the abandoned run and skip global canonical, foreign-key, FTS content, and FTS semantic scans |
| Newly created library                                                                                                                               | `bootstrap`; initialize the current schema and empty projection                                                               |
| Missing, stale, malformed, wrong-generation, wrong-schema, wrong-cookie, free, maintenance, migration-era, or structurally invalid receipt evidence | `full-validation`; run the complete canonical, foreign-key, and FTS validation/repair path                                    |

A live lease remains busy rather than becoming a recovery mode. An expired
`clear` lease remains clear-only. Unsafe, incompatible, newer-schema, and orphan
sidecar states keep their existing fail-closed lifecycle result. A missing or
altered receipt table is repaired only after exact writer ownership is acquired,
and that open must still complete full validation before it can create new
proof. If the isolated repair cannot be proved, opening fails closed.

Every successful mode configures persistent FTS settings and opens the private
capture workspace before creating the current generation's sequence-zero
receipt as the final integrity-bearing setup mutation. A crash earlier in setup
therefore leaves no reusable receipt. A normal close still seals and publishes
the stronger post-close clean proof; its remaining receipt is ineligible beside
a free lease. Forget, orphan repair, compaction, and clear do not advance an
index receipt and force the existing full-validation path before a later index
can establish new proof.

`doctor` remains the explicit immutable whole-library semantic audit. Certified
recovery does not resume an interrupted run: the abandoned run is marked
interrupted and the new invocation performs provider discovery and indexing from
the beginning, using normal incremental fingerprint behavior.

## Threat boundary

The receipt proves only mutations performed through supported Sessions index
transactions. It relies on SQLite transaction and crash/WAL recovery and on the
permission-hardened local library. Like the clean fast path, it does not detect
arbitrary same-user, same-schema out-of-band row edits. It is not protection
against malware, disk loss, privileged filesystem access, or another process
running as the same user. Those threats remain outside the supported trust
boundary; users who need an explicit current semantic proof run `sessions
doctor`.

## Consequences

- An ordinary crash after a certified transaction boundary can reopen with
  constant-size proof work instead of a corpus-sized validation scan.
- Any ambiguity disables the optimization rather than weakening validation.
  Full validation and repair remain the correctness control and establish a new
  receipt only after they succeed.
- Recovery changes no public index report, capture scope, retained evidence,
  query result, provider-read-only behavior, or exit code. Interactive stderr may
  name the bounded certified-recovery mode without claiming a whole-library scan
  or run continuation.
- The operation sequence is evidence that known mutation owners committed at
  certified boundaries. It cannot discover a future write path that bypasses
  the wrapper, so an architecture test keeps index-purpose persistent
  transactions on the explicit allowlist.
