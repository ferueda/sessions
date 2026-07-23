# Doctor document-interval feasibility

## Status

Measurement and human review completed on 2026-07-23. Document-bounded
`fts5vocab(..., 'instance')` scans are rejected as the basis for bounded doctor
verification.

Production `doctor` behavior is unchanged. Sections 2–3 of the originating plan
are retired; successor work is evidence-gated in
[the single-pass FTS feasibility plan](../../dev/plans/260723-doctor-single-pass-fts-feasibility.md).

## Question

Can exact doctor FTS verification divide the actual FTS vocabulary into many
document-ID intervals without repeatedly traversing the complete vocabulary?

The proposed design would build and discard one bounded expected TEMP FTS
projection per canonical-content interval. That only helps if the matching
document-bounded reads of the actual `fts5vocab` projection also have bounded
work.

## Method

`pnpm measure:doctor` creates two provider-free libraries through the production
SQLite writer. Each includes:

- repeated shared and unique generated text;
- zero-token and multibyte text;
- one generated value above the 16 MiB byte-interval target; and
- one generated term above a reduced measurement-only instance target.

The measurement closes the writer, creates byte-identical mode-`0600` clones,
and runs every strategy in alternating fresh child processes. Measured workers
open the clone with `mode=ro&immutable=1`, require memory-only TEMP storage, and
consume:

- raw `(term, doc, col, offset)` instance rows; and
- term summaries grouped by term with exact document and instance counts.

The `one`, `two`, and `many` strategies cover the same document IDs and include
the required final actual-vocabulary tail query. `one` and `two` are equal-split
controls. `many` uses the proposed production admission rule: at most 512
canonical rows or 16 MiB of UTF-8 text per interval, with an oversized value
processed alone. Exact coordinate and merged term-summary equality run
separately so their retained comparison state does not contaminate measured
peak RSS.

Elapsed time and RSS are observations, not correctness thresholds. The OS page
cache is not flushed, so these are comparative warm measurements rather than
cold-start results. The probe is supported on macOS and Linux because its
private-file evidence relies on POSIX modes.

Environment:

- Node.js 24.18.0
- SQLite 3.53.3
- macOS arm64

## Result

All values below are medians of three fresh-process samples. Peak RSS is the
largest child-process value across those samples.

| Corpus | Content rows | FTS instances | Database bytes |
| ------ | -----------: | ------------: | -------------: |
| Small  |          516 |         4,616 |     17,215,488 |
| Large  |       20,004 |       180,008 |     25,833,472 |

### Small corpus

| Intervals | Queries per shape | Raw instances | Term summaries |    Total |  Peak RSS |
| --------: | ----------------: | ------------: | -------------: | -------: | --------: |
|         1 |                 2 |      4.970 ms |       1.213 ms | 6.138 ms | 119.9 MiB |
|         2 |                 3 |      5.551 ms |       1.423 ms | 6.976 ms | 117.7 MiB |
|         3 |                 4 |      5.524 ms |       1.674 ms | 7.199 ms | 117.8 MiB |

At three admission intervals, total elapsed was 1.17 times the one-interval
result. Raw instance work was 1.11 times slower and grouped term-summary work was
1.38 times slower.

### Large corpus

| Intervals | Queries per shape | Raw instances | Term summaries |      Total |  Peak RSS |
| --------: | ----------------: | ------------: | -------------: | ---------: | --------: |
|         1 |                 2 |    114.368 ms |      35.653 ms | 150.365 ms | 169.7 MiB |
|         2 |                 3 |    130.498 ms |      42.172 ms | 172.672 ms | 168.6 MiB |
|        41 |                42 |    330.567 ms |     243.201 ms | 571.614 ms | 162.9 MiB |

At 41 production-shaped admission intervals, total elapsed was 3.80 times the
one-interval result. Raw instance work was 2.89 times slower and grouped
term-summary work was 6.82 times slower. The strategies returned the same
180,008 exact instances.

Each query-count value is per measured shape: the worker runs that many raw
instance queries and that many grouped term-summary queries. Peak RSS in this
actual-vocabulary-only probe was 0.96 times the one-interval maximum. It does not
construct the proposed interval-local expected projection, so it neither proves
nor disproves that the complete design could reduce expected-side memory.

Two subsequent complete invocations reproduced the large-corpus direction at
41 intervals: 3.64–3.73 times total, 2.74–2.82 times raw-instance, and 6.47–6.59
times grouped term-summary work. Both passed every hard correctness gate.
Small-corpus timings were within process noise and are not decision evidence.

For both query shapes, normalized `EXPLAIN QUERY PLAN` facts were identical for
unbounded, prefix, middle, and final-tail predicates:

- one virtual-table scan;
- no TEMP B-tree for raw instance consumption; and
- two TEMP B-trees for grouped term summaries.

The combined plan and scaling evidence is consistent with repeated
whole-vocabulary traversal rather than document-bounded access.

## Correctness and privacy evidence

Both cohorts required:

- exact ordered coordinate equality between whole-vocabulary and concatenated
  interval reads;
- exact merged term/document/instance summary equality;
- exact docsize coverage, including zero-token rows;
- disjoint, complete interval accounting and an empty final tail;
- healthy production index inspection after measurement;
- byte-identical initial clones;
- unchanged device, inode, mode, ownership, link count, size, modification and
  change timestamps, and SHA-256 digest after immutable reads;
- absent WAL, SHM, and journal sidecars before and after;
- mode-`0700` owned temporary directories and mode-`0600` database files; and
- complete temporary cleanup on success and a forced measured-child failure.

The report contains only generated aggregate data. Contract tests recursively
allowlist report fields and reject generated text, terms, identities, locators,
paths, hashes, timestamps, raw SQL, errors, and process IDs.

## Accepted decision

The document-ID interval design in sections 2–3 of the originating doctor plan
is rejected. It can bound the expected TEMP projection, but its
actual-vocabulary query shape introduces an interval-count CPU multiplier on
the dominant doctor path.

Preserve the current exact audit until a replacement design is accepted.
The successor feasibility plan evaluates one direct actual/expected instance
stream as a possible CPU improvement. It does not claim bounded total memory:
the complete expected TEMP FTS remains corpus-sized until a safe, exact
tokenizer-ordering primitive exists.
