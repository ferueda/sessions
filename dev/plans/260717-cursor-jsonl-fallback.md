# Add Cursor JSONL fallback without evidence downgrade

## Goal

Capture current local Cursor history that exists only under the recognized
`agent-transcripts` JSONL layout while preserving the richer store-backed
sessions delivered by M11b.

The read-only survey found 1,717 JSONL files. Exactly 1,198 map one-to-one to
current rich candidates and remain governed only by `chat-store-v1` or
`agent-checkpoint-store-v1`. Of the remaining 519 artifacts, 500 contain
conversation records and 19 contain lifecycle records only. Seven bare
basenames each identify two byte-different files, so those 14 artifacts do not
prove two safe provider-native identities.

Use the bare JSONL basename as native identity only when the generation contains
one artifact for that basename. This preserves same-ID JSONL-to-rich promotion.
Represent a duplicate-basename group as one discovered conflict candidate whose
ordered inputs cover every conflicting file and whose read fails
`unsupported-format`. Do not invent project-scoped IDs, choose one file, merge
bytes, or expose project directory keys. A resolved later generation can capture
that same bare identity without rekeying it.

## Changes

1. Extend the provider-neutral source port with a small replacement guard.
   - Add an optional synchronous `SessionSource.canReplace` decision that
     receives only the last-good and candidate adapter-version strings.
   - `run-index.ts:applyCandidate` calls it after exact unchanged detection and
     before `read`. Absent means allowed. `false` records the existing
     `unsupported-format` candidate failure, leaves the candidate present, and
     preserves any last-good document as stale.
   - Invoke the optional guard through one fail-closed helper. A thrown error or
     any non-boolean runtime result is treated exactly like `false`: do not call
     `read`, record `unsupported-format` for that candidate, preserve last-good
     evidence as stale, and continue the source run.
   - Cursor uses `cursor-v1` for both rich store families and
     `cursor-jsonl-v1` for the reduced fallback. Allow same-family changes and
     JSONL-to-rich promotion; reject rich-to-JSONL downgrade. Explicit forget
     remains the user-controlled way to remove retained rich evidence and later
     admit the reduced source as a new first capture.
   - Keep this provider-neutral: no Cursor branch, fidelity rank, schema column,
     query rule, or presentation change enters the engine. Validate the optional
     method at source selection and cover an invalid runtime result without
     weakening existing adapters.

2. Extend Cursor inventory and discovery over only the frozen JSONL grammar.
   - Admit regular files at
     `projects/<project>/agent-transcripts/<id>/<same-id>.jsonl` and
     `projects/<project>/agent-transcripts/<parent>/subagents/<child>.jsonl`.
     Treat containment as traversal only; do not publish a parent relation.
   - Require the exact observed lowercase UUID form, with the declared optional
     `agent-` prefix only for top-level IDs. Never decode project directory
     names, recurse beyond the grammar, or follow symlinks.
   - Include every relevant directory/file descriptor in both stable inventory
     passes. Addition, removal, replacement, type drift, symlink presence, or
     descriptor drift makes discovery incomplete.
   - Apply authoritative ownership before fallback grouping. An exact rich
     candidate wins and every same-ID JSONL artifact stays out of its
     fingerprint. An explicit `hasConversation: false` chat remains a
     noncandidate and suppresses same-ID JSONL fallback. Only an otherwise
     unowned basename is eligible for fallback: one artifact yields
     `agent-transcript-jsonl-v1`; more than one yields one conflict candidate
     whose inputs cover every file in binary grammar-address order. The extra
     artifact has no safe distinct identity.
   - Give JSONL and conflict candidates opaque logical locators and complete
     descriptor fingerprints without public paths, project keys, or content
     hashes. Discovery stats files but never opens or parses transcript bytes,
     so unchanged runs remain cheap.

3. Add a strict streaming JSONL reader and fallback normalizer.
   - Stream one unique frozen file from an `O_NOFOLLOW` handle. Compare its full
     descriptor before open, after open, after parsing, and after path
     re-description. Mutation wins over a simultaneous parse error and becomes
     `source-changed`, using the existing one-pass rediscovery retry.
   - Decode UTF-8 fatally, require one plain JSON object per nonempty physical
     line, and cap each record at 32 MiB. Malformed bytes/JSON/primitives are
     `malformed`; unknown keys, roles, record kinds, content kinds, status
     values, input variants, and oversized records are `unsupported-format`.
   - Accept exact message records `{ role, message: { content } }` for `user`
     and `assistant`. Content is a dense array. User items are exact
     `{ type: "text", text }`; assistant items are exact text items or
     `{ type: "tool_use", name, input }`.
   - Preserve file order and content-array order. User text becomes human
     `message`; assistant text becomes model `message`; tool use becomes model
     `tool-call` with exact name, absent namespace/call ID/result linkage, exact
     raw string input, or existing canonical JSON for a plain-object input.
   - Accept lifecycle records exactly as
     `{ type: "turn_ended", status: "success" }` or
     `{ type: "turn_ended", status: "error"|"aborted", error }`. Emit ordered
     system entries `turn-completed`, `turn-error`, or `turn-aborted`; preserve
     the exact error string as text for error/aborted and use empty content for
     success. Lifecycle records may repeat or precede later messages.
   - Admit lifecycle-only files when no explicit `hasConversation: false`
     metadata excludes them. Omit title, workspace, created/updated timestamps,
     entry timestamps, relations, and inferred lineage. File times participate
     only in source-change fingerprints; they are not canonical conversation
     timestamps. Preserve injected text exactly.
   - A conflict candidate read deterministically returns `unsupported-format`
     without opening any conflicting file.

4. Prove the behavior at the smallest stable seams.
   - Add generated Cursor fixtures for both path variants, message/tool/lifecycle
     records, rich overlap, explicit noncandidate metadata, duplicate basenames
     across projects and top-level/child positions, malformed/drifting files,
     symlinks, and unknown layouts.
   - Parser/normalizer tests cover exact ordering, raw-string and object tool
     inputs, missing tool IDs/results, lifecycle-only sessions, fatal UTF-8,
     record bounds, malformed versus unsupported drift, and no inferred
     metadata or relations.
   - Discovery/source tests prove rich precedence, no JSONL input in rich
     fingerprints, one unique fallback per basename, one isolated conflict
     failure without making the whole generation incomplete, binary ordering,
     stable double inventories, no-follow reads, all mutation windows, and no
     private path or content in errors.
   - Provider-neutral indexing tests prove default adapters remain unchanged;
     first JSONL capture works; stable JSONL is unchanged without another read;
     JSONL-to-rich replaces the same identity; rich-to-JSONL records
     `unsupported-format` and preserves the rich last-good document; forgetting
     then indexing permits a reduced first capture. A throwing or non-boolean
     replacement guard fails only that candidate without calling `read` or
     aborting the source run.
   - Add one representative Cursor SQLite fallback journey that proves durable
     capture, a structured query, export, stable unchanged behavior, and
     last-good preservation. Extend the single shared distribution smoke only
     enough to prove compiled default and explicit Cursor composition can index
     and retrieve a fallback session. Reuse existing command, maintenance,
     capture-scope, structured-output, Codex, and rich Cursor contract suites
     instead of repeating every operation at every layer.

5. Update current contracts and roadmap.
   - Update Cursor format support, local-format evidence, source survey,
     adapter/architecture/privacy/testing references, README, and the V1 roadmap.
   - State that JSONL fallback lacks timestamps, tool results, call IDs,
     linkage, titles, workspace metadata, and proven lineage. Absence of those
     fields is missing evidence, not proof the event or relation did not occur.
   - Record the duplicate-basename failure policy and rich-to-reduced
     last-good preservation. Keep cloud-only, legacy App Support, and inferred
     relations deferred.
   - Remove this completed executor plan and restore `dev/plans/README.md` to
     M12 when implementation and verification finish.

## Verify

- Focused Cursor parser/discovery/source, application indexing, SQLite vertical,
  CLI/distribution, contract, and documentation tests.
- Privacy-safe live acceptance against current local Cursor data with a
  temporary mode-0700 Sessions library:
  - reconcile rich, unique JSONL, explicit noncandidate, lifecycle-only, and
    conflict aggregates without printing identities, paths, text, tool names,
    timestamps, errors, or hashes;
  - first index captures the eligible unique fallback cohort while conflict
    candidates fail honestly;
  - second index reports rich and fallback sessions unchanged while repeating
    only the bounded conflict failures;
  - select one fallback identity in memory and prove one native-ID lookup plus
    one export without emitting private evidence;
  - prove provider main/WAL/SHM/JSONL bytes and descriptors unchanged, no
    Sessions scratch residue, and cleanup in `finally`.
- `pnpm check`.

## Boundaries

- No project-derived public identity, duplicate-file choice/merge, cross-format
  textual deduplication, provider API, hook, network call, cloud/legacy reader,
  raw backup, attachment capture, or lineage inference.
- No canonical schema migration, persistence/query special case, public
  structured-output field, date-filter shortcut, or automatic deletion.
- Do not weaken rich Cursor authority or add JSONL files to rich candidate
  fingerprints merely to supplement missing fields.
