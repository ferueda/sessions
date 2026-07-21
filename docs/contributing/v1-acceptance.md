# V1 standalone acceptance

This ledger records completed standalone Sessions V1 acceptance. It separates
deterministic regression proof, privacy-safe local dogfood, the frozen legacy
comparison, published-package qualification, and the final standalone release
and local installation gate.

## Outcome matrix

The legacy baseline is Harness commit `7ac1839f`, the parent of the merge that
removed its Sessions implementation. The comparison is at the user-outcome
level:

| User outcome                    | Standalone Sessions                                                                                                                                   | Legacy Harness evidence                                                  | Parity decision                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Refresh local history           | `sessions index` for one or all ready sources                                                                                                         | Provider `reindex` commands                                              | Equivalent outcome; command and cache layout are intentionally different                              |
| Discover retained sessions      | `sessions list` with provider-neutral filters and capture scope                                                                                       | Provider `list` and metadata filters                                     | Equivalent discovery; automation defaults and Harness table layout are not required                   |
| Find transcript evidence        | Literal `sessions search` plus textless `sessions entries`                                                                                            | `sessions analyze --include-turns`, `--turn-query`, and extraction modes | Equivalent lookup; standalone exposes canonical evidence and leaves interpretation to the Agent Skill |
| Inspect or hand off one session | Bounded `show` and JSON/JSONL `export`                                                                                                                | Provider `show` and `export`                                             | Equivalent inspection and machine handoff                                                             |
| Preserve trustworthy results    | Canonical document/content digests, stable order, provenance, lineage coverage, support units, last-good retention, typed failures, and capture scope | Cached normalized transcripts and analysis tests                         | Standalone is stricter; legacy output shape and cache internals are not compatibility surfaces        |

The legacy suite passed at the frozen baseline on 2026-07-20: 21 test files and
135 tests, including CLI, Cursor, Codex, cache, filters, transcript search,
show/export, and analysis behavior. Current Harness merge `cbaa5bc9` has already
removed that implementation. It remains historical comparison evidence only;
the accepted product has no Harness repository wrapper, pin, cache, or rollback
route.

## Deterministic provider proof

`test/contracts/provider-workflow.contract.ts` drives Codex, Cursor, and the
test-only `synthetic-third` adapter through the same in-process CLI,
provider-neutral application services, and SQLite lifecycle. The matrix covers:

- first, stable, changed, missing, unavailable, stale, and recovered indexing;
- list, literal search, textless entries, bounded show, and full export;
- document and content digests, order, provenance, lineage coverage, support
  units, typed failures, and filtered capture scope; and
- byte-identical provider fixture state around every index and query operation.

The third adapter is registered only through injected test ports. It requires no
change under `src/domain/`, `src/application/`, `src/infrastructure/`,
`src/cli/`, or `src/bin/` and does not create a public V1 plugin ABI. Existing
adapter conformance and vertical-slice tests continue to own provider-specific
format branches.

## Authorized live proof

Both local checks require the exact `--allow-provider-read` acknowledgement,
use production adapters and fresh mode-0700 temporary libraries, emit aggregate
JSON only, and remove their temporary roots. They never open the ordinary
Sessions library.

Results recorded on 2026-07-20:

| Source | Admitted cohort | Seed                               | Stable                                                   | Byte proof                                          | Library proof                   |
| ------ | --------------: | ---------------------------------- | -------------------------------------------------------- | --------------------------------------------------- | ------------------------------- |
| Codex  |             120 | 120 updated; all other counts zero | 120 unchanged; all other counts zero; zero content reads | 120 selected rollouts, 295,317,990 bytes, unchanged | Healthy; clean writer integrity |
| Cursor |             120 | 120 updated; all other counts zero | 120 unchanged; all other counts zero; zero content reads | 236 selected inputs, 54,019,335 bytes, unchanged    | Healthy; clean writer state     |

The Cursor preflight encountered zero typed failures before admitting its 120
supported candidates. These counts describe only the bounded acceptance cohorts;
they are not an inventory of either private provider history. No identities,
paths, hashes, or transcript text are retained here.

## Distribution and Agent Skill proof

Routine `pnpm check` builds one tarball, installs it offline outside the checkout,
checks the exact independent ten-file Sessions skill tree, and runs the shared
synthetic Cursor/Codex CLI workflow. Release qualification repeats one hashed
artifact through ordinary global npm install, the installed shim, pinned `npx`,
and Linux/macOS/Windows jobs.

The protected Release workflow completed on 2026-07-21 for immutable tag
`v0.2.0` at commit `568c1e7b29f6d3ed825d21d8d64788e5391cbd26`.
One qualified tarball passed the Linux, macOS, and Windows release smokes before
publication. Its exact SHA-256 is
`5a14be5603578d2e3980a6c503e15adaf704b5356760e0363229853a17d7ef28`.
The public registry reports `0.2.0` as `latest`, SHA-512 integrity
`sha512-jXUhQJYNDsMQ7dBoPd026bRFg3jM+4iz0jVrrIXgtNmXm54IOoP9Vlk8lZFQlN3bI/OaVTYmD/DqioHt2rWH9A==`,
a registry signature, and SLSA provenance. A clean registry install and the
published tarball matched the qualified bytes.

The same day, the ordinary global CLI was upgraded to `0.2.0` and the copied
Agent Skill was upgraded directly from immutable tag `v0.2.0`. The local skill
lock records source `ferueda/sessions`, ref `v0.2.0`, and the packaged skill
path. The release tag, globally installed npm package, and copied local skill
have exact byte equality across the same ten regular files. Read-only `paths`
reported a ready schema-1 library and ready Codex and Cursor probes. Full
`doctor` passed the runtime, SQLite/FTS5, library, and both source checks; on the
2.6 GB local library its whole-library validation took about eight minutes. Its
incomplete-evidence summary is an expected capture warning, not a failed health
check. No indexing ran as part of release acceptance.

## V1 closure

There are no remaining V1 gates. `0.2.0` is the supported standalone release,
and the finished implementation roadmap and M13.3 executor plan remain in Git
history rather than the active plan directory.
