# Deliver JSON and JSONL structured output

## Goal

Expose the canonical export foundation through stable, bounded, provider-free
machine output. Add versioned JSON and independently attributable JSONL to
`list`, `search`, and `show`, plus a new `sessions export` command that emits one
retained session as portable JSON or JSONL context. Use one safe DTO construction
and one selection result per command before either renderer encodes it.

This plan intentionally does not implement Markdown. Markdown remains a separate
presentation layer over the same projection and a pre-M9/V1 gate, while M8 may
begin after this provider-neutral JSON/JSONL contract lands.

## Prerequisite and locked contract

- Implement only after `260715-canonical-export-foundation.md` lands. Rebase and
  verify the exact public projection, stored digest, attribution, and schema
  checksum; stop if they differ from this plan rather than duplicating them.
- `list`, `search`, and `show` accept `--format human|json|jsonl` and default to
  `human`. `export` requires `--format json|jsonl` and accepts optional `--full`.
  Operational reports keep their existing `human|json` union. Omitted export
  format, `md`, YAML, unsupported values/flags, or invalid option combinations are
  usage errors with exit `2`.
- All structured records use numeric `schemaVersion: 1`, a fixed `command` and
  `type`, and `disposition: "untrusted-history"`. Every session/evidence-bearing
  record repeats its canonical session reference and document digest so each
  JSONL line is attributable without prior lines. Transcript text remains exact
  historical data, not executable instructions; JSON escaping protects syntax,
  not semantic trust.
- JSON emits one bundle. JSONL emits compact one-object-per-physical-line records;
  embedded newlines remain JSON escapes. Build and validate the complete result
  before the first stdout write so corruption cannot produce a successful-looking
  partial stream. JSONL is independently parseable, not a V1 low-memory promise,
  because canonical reads already materialize the retained document.
- Set `MAX_BOUNDED_STRUCTURED_OUTPUT_BYTES` to exactly 16 MiB. Measure the actual
  UTF-8 bytes of complete encoded JSON or joined JSONL records—including escaping,
  formatting, newlines, and truncation metadata—before stdout. Every JSON/JSONL
  list, search, show, and default export at or below the cap succeeds; one byte
  above fails with sanitized `structured-output-too-large`, exit `1`, no stdout,
  and guidance to narrow list/search or use `export --full`. Structural strings
  remain exact rather than individually truncated. `export --full` is the sole
  machine route exempt from this aggregate presentation cap because the user
  explicitly requested every export-eligible field.
- Format never enters list/search query fingerprints. Identical queries can reuse
  the same opaque cursor across human, JSON, and JSONL. Empty list/search still
  emit a page record and exit `0`; absent show/export is an operational exit `1`.
- Export reads one retained canonical snapshot only. It never probes/reopens an
  adapter, follows relations, imports data, contacts a provider, writes a
  destination, or infers lineage from equal text/digests.

## Default transcript selection

Apply selection once before rendering. Keep list/search limits, search excerpt
bounds, ranking, context, and cursor semantics unchanged.

Every list/search/show and bounded-export public title uses the same optional
schema-1 `SelectedTextV1` defined in the exact wire contract below. When a
canonical title exists, truncate it at a well-formed Unicode code-point boundary
to at most 8 KiB raw UTF-8 and always emit all four fields; when absent, omit the
title member rather than emitting `null`. `export --full` emits the complete title
with `truncated: false` and equal original/emitted byte counts. Apply selection
before human, JSON, or JSONL rendering. Human list/search/show then retain the
existing post-escape 8 KiB terminal scalar cap and visible suffix. Title selection
is presentation only, never enters query filters, ranking, cursor fingerprints,
or the full document digest.

Show keeps its current first-50-entry or focused-entry/context window. After that
window is fixed, apply the same relation, segment, per-segment raw-text, aggregate
raw-text, and title limits listed below for default export. Show has no `--full`:
it always emits at most 50 relations, 100 segments across the selected entry
window, 8 KiB raw UTF-8 per text segment, 256 KiB raw UTF-8 across selected
segment text, and 8 KiB raw UTF-8 of title. Process relations in canonical order,
then entries/segments in canonical order. The title has its separate budget and
does not consume the segment-text budget. Omitted-content segments consume a
segment slot but no text bytes. Every entry in the already-selected show window
retains its structural record even when all its segments are omitted or have zero
remaining text budget. The show envelope reports total and selected relations,
entries, and segments, selected entry ordinal range, original/emitted title bytes,
original/emitted segment-text bytes, and exact omitted/truncated counts.

Move raw selection/accounting before all show renderers, but retain human
rendering's current terminal-specific second safety layer: after escaping control
characters, cap every rendered scalar/heading at 8 KiB and each rendered entry
body at 256 KiB including separators and visible omission/truncation markers.
Those post-escape caps can display less than the selected raw value when escapes
expand; the visible human truncation suffix remains. They are encoding safety,
not schema-1 raw-byte selection, and JSON/JSONL metadata reports only the shared
pre-render raw selection. Human show remains entry-focused and need not add a new
lineage section in this plan. This deliberately makes the rare over-limit human
case more bounded while preserving current entry-window, terminal escaping,
suffix, and per-rendered-value caps.

For default export, select one contiguous prefix in canonical entry order with
these fixed internal V1 bounds. Entry timestamps never sort or reorder evidence:

- first 50 entries;
- first 50 ordered relations;
- first 100 segments across selected entries;
- at most 8 KiB raw UTF-8 from each text segment;
- at most 256 KiB raw UTF-8 across emitted transcript segment text;
- at most 8 KiB raw UTF-8 from the title.

These constants are evidence-backed: a privacy-safe aggregate audit of 1,444
retained sessions found first-50-entry projections with at most 102 segments and,
after the 8 KiB per-segment cap, 1,443/1,444 sessions at or below 256 KiB raw text.
They are raw admitted-text budgets, not estimates of JSON-escaped output size; the
separate 16 MiB encoded-byte ceiling is the exact aggregate bound. A second
privacy-safe aggregate audit found current maximum structural values far below
that ceiling: 80-byte source-instance/target IDs, 36-byte native/target IDs,
8-byte adapter versions, 19-byte entry kinds, 29-byte call IDs, 33-byte tool
names, and 23-byte namespaces. Keep only these aggregate measurements in
contributor documentation—never local paths, identities, hashes, or transcript
values.

Truncate strings only at well-formed Unicode code-point boundaries and report
original/emitted UTF-8 byte counts. Always retain structural values exactly:
identity, ordinals, timestamps, hashes, tool/linkage fields, relation targets,
segment kind, origin, and confidence. They are protected by the aggregate encoded
cap, not shortened into ambiguous identifiers. When a selected entry's text
budget is exhausted, retain the selected segment structure with empty/truncated
text and its full canonical content hash. A segment excluded by the 100-segment
limit is omitted and counted; all earlier selected segment structures remain.
When relation/entry/segment count bounds omit records, report exact selected/total
counts and the selected ordinal range. Canonical omitted-content records remain
distinct from CLI truncation. `--full` removes these export presentation bounds
and the aggregate encoded cap, and emits every export-eligible field in the one
retained snapshot; it never reveals fields excluded by the canonical public
projection. Export has no cursor and does not auto-expand for linked calls/results.

## Structured record inventory

Define exact closed DTOs and key tests in a focused `src/cli/structured-output.ts`
owner. Reuse the existing canonical `SessionRef` shape (`canonicalId`, source
kind/instance, native ID) rather than inventing a second identity encoding. Never
spread a `SessionDocument`, `SessionEntry`, `SessionQuerySummary`, search row, or
SQLite row into a DTO because those values can contain workspace/diagnostic data.

- JSON `list`: one bundle with command metadata, `nextCursor: string | null`, and
  ordered public session summaries. JSONL: one `page` record followed by ordered
  `session` records. Each summary includes the bounded `SelectedTextV1` title when
  present, provider timestamps,
  capture/source observation, source state, freshness, last-good adapter version,
  and document digest; never workspace.
- JSON `search`: one bundle with command metadata, support totals, explicit
  `nextCursor`, and ordered hits. JSONL: one `page` record carrying support/cursor
  followed by ordered `hit` records. A hit includes its session attribution,
  entry coordinate/provenance/tool/linkage, primary segment coordinate/origin,
  emitted excerpt/truncation, full canonical content hash, additional-match count,
  and context records explicitly typed `entry-excerpt`. Context is not represented
  as a complete canonical entry/segment. Preserve current support units/ranking.
- JSON `show`: one snapshot bundle plus the current selected entries. JSONL: one
  `session` envelope, ordered `relation` records, then ordered `entry` records.
  The envelope includes totals and selection/truncation before any entry line;
  entry records contain their ordered safe segments and repeat session ref/digest.
  An empty-entry snapshot still emits its envelope.
- JSON `export`: the same snapshot envelope/public relation/public entry evidence
  as JSONL nested into one bundle. JSONL uses the same `session`, `relation`, and
  `entry` record shapes with `command: "export"`. JSON and JSONL must carry
  equivalent eligible evidence and the same persisted digest for a given
  selection. The envelope contains capture time, effective source state and
  observation time, last-good adapter version, freshness, full-document digest,
  lineage coverage, and explicit title/relation/entry/segment/text selection.

Changing field meaning or record inventory requires a later schema version. The
exact optional/null behavior fixed below must be reproduced in
`docs/reference/structured-output.md` and enforced by schema-1 golden tests rather
than inferred from TypeScript serialization.

## Exact schema-1 wire contract

The following types are the authoritative schema. Implementation and
`docs/reference/structured-output.md` reproduce them; neither may invent fields.
Object-key serialization order is deterministic but not semantic. Array and JSONL
record order is semantic.

```ts
type StructuredCommandV1 = "list" | "search" | "show" | "export";

interface StructuredHeaderV1<Command extends StructuredCommandV1, Type extends string> {
  readonly schemaVersion: 1;
  readonly command: Command;
  readonly type: Type;
  readonly disposition: "untrusted-history";
}

interface SessionRefV1 {
  readonly canonicalId: string;
  readonly source: { readonly kind: string; readonly instanceId: string };
  readonly nativeId: string;
}

interface SessionDocumentDigestV1 {
  readonly scheme: "sha256-sessions-document-jcs-v1";
  readonly digest: string;
}

interface SelectedTextV1 {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalUtf8Bytes: number;
  readonly emittedUtf8Bytes: number;
}

interface PublicSessionSummaryV1 {
  readonly session: SessionRefV1;
  readonly documentDigest: SessionDocumentDigestV1;
  readonly title?: SelectedTextV1;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly capturedAt: string;
  readonly sourceState: "present" | "missing" | "unknown";
  readonly sourceObservedAt: string;
  readonly adapterVersion: string;
  readonly freshness: "current" | "stale";
}

interface CountSelectionV1 {
  readonly selected: number;
  readonly total: number;
  readonly truncated: boolean;
}

interface EntrySelectionV1 extends CountSelectionV1 {
  readonly firstOrdinal: number | null;
  readonly lastOrdinal: number | null;
}

interface ByteSelectionV1 {
  readonly emittedUtf8Bytes: number;
  readonly originalUtf8Bytes: number;
  readonly truncated: boolean;
}

interface TranscriptSelectionV1 {
  readonly mode: "bounded" | "full";
  readonly relations: CountSelectionV1;
  readonly entries: EntrySelectionV1;
  readonly segments: CountSelectionV1;
  readonly segmentText: ByteSelectionV1;
  readonly canonicalOmittedSegments: number;
  readonly truncatedTextSegments: number;
}

interface PublicSessionSnapshotV1 extends PublicSessionSummaryV1 {
  readonly lineageCoverage: "complete" | "unknown";
  readonly selection: TranscriptSelectionV1;
}

interface PublicRelationV1 {
  readonly ordinal: number;
  readonly kind: "parent" | "child" | "fork" | "continuation" | "unknown";
  readonly target: SessionRefV1;
  readonly confidence: "high" | "medium" | "low" | "unknown";
}

interface PublicEntryCoordinateV1 {
  readonly ordinal: number;
  readonly kind: string;
  readonly actor: "human" | "model" | "tool" | "system" | "unknown";
  readonly timestamp?: string;
  readonly relatedEntryOrdinal?: number;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly toolNamespace?: string;
}

interface PublicTextSegmentV1 {
  readonly ordinal: number;
  readonly kind: "text";
  readonly origin:
    | "human"
    | "injected"
    | "delegated"
    | "replayed-copied"
    | "model"
    | "tool"
    | "system"
    | "unknown";
  readonly originConfidence: "high" | "medium" | "low" | "unknown";
  readonly text: SelectedTextV1;
  readonly contentHash: {
    readonly scheme: "sha256-utf8-v1";
    readonly digest: string;
  };
}

interface PublicOmittedSegmentV1 {
  readonly ordinal: number;
  readonly kind: "omitted";
  readonly origin:
    | "human"
    | "injected"
    | "delegated"
    | "replayed-copied"
    | "model"
    | "tool"
    | "system"
    | "unknown";
  readonly originConfidence: "high" | "medium" | "low" | "unknown";
  readonly contentClass: "image" | "resource" | "structured" | "unknown";
  readonly sourceType: string;
}

type PublicSelectedSegmentV1 = PublicTextSegmentV1 | PublicOmittedSegmentV1;

interface PublicSelectedEntryV1 extends PublicEntryCoordinateV1 {
  readonly content: readonly PublicSelectedSegmentV1[];
  readonly omittedSegmentCount: number;
}

interface SearchExcerptV1 {
  readonly text: string;
  readonly truncated: boolean;
}

interface SearchContextExcerptV1 {
  readonly type: "entry-excerpt";
  readonly entry: PublicEntryCoordinateV1;
  readonly excerpt: SearchExcerptV1;
  readonly adjacent: boolean;
  readonly linked: boolean;
}

interface PublicSearchHitV1 {
  readonly session: PublicSessionSummaryV1;
  readonly entry: PublicEntryCoordinateV1;
  readonly match: {
    readonly segmentOrdinal: number;
    readonly origin:
      | "human"
      | "injected"
      | "delegated"
      | "replayed-copied"
      | "model"
      | "tool"
      | "system"
      | "unknown";
    readonly originConfidence: "high" | "medium" | "low" | "unknown";
    readonly excerpt: SearchExcerptV1;
    readonly contentHash: {
      readonly scheme: "sha256-utf8-v1";
      readonly digest: string;
    };
    readonly additionalMatchingSegments: number;
  };
  readonly context: readonly SearchContextExcerptV1[];
  readonly linkedContextTruncated: boolean;
}

interface SearchSupportV1 {
  readonly occurrences: number;
  readonly uniqueContent: number;
  readonly uniqueKnownRoots: number;
  readonly unknownLineageSessions: number;
}
```

The four JSON bundles are exact intersections with the common header:

```ts
type ListJsonV1 = StructuredHeaderV1<"list", "page"> & {
  readonly nextCursor: string | null;
  readonly sessions: readonly PublicSessionSummaryV1[];
};

type SearchJsonV1 = StructuredHeaderV1<"search", "page"> & {
  readonly nextCursor: string | null;
  readonly support: SearchSupportV1;
  readonly hits: readonly PublicSearchHitV1[];
};

type ShowJsonV1 = StructuredHeaderV1<"show", "snapshot"> & {
  readonly snapshot: PublicSessionSnapshotV1;
  readonly relations: readonly PublicRelationV1[];
  readonly entries: readonly PublicSelectedEntryV1[];
};

type ExportJsonV1 = StructuredHeaderV1<"export", "snapshot"> & {
  readonly snapshot: PublicSessionSnapshotV1;
  readonly relations: readonly PublicRelationV1[];
  readonly entries: readonly PublicSelectedEntryV1[];
};
```

JSONL accepts only these records, in the declared command order:

```ts
type ListPageJsonlV1 = StructuredHeaderV1<"list", "page"> & {
  readonly sessionCount: number;
  readonly nextCursor: string | null;
};
type ListSessionJsonlV1 = StructuredHeaderV1<"list", "session"> & {
  readonly summary: PublicSessionSummaryV1;
};

type SearchPageJsonlV1 = StructuredHeaderV1<"search", "page"> & {
  readonly hitCount: number;
  readonly nextCursor: string | null;
  readonly support: SearchSupportV1;
};
type SearchHitJsonlV1 = StructuredHeaderV1<"search", "hit"> & {
  readonly hit: PublicSearchHitV1;
};

type SnapshotSessionJsonlV1<Command extends "show" | "export"> = StructuredHeaderV1<
  Command,
  "session"
> & {
  readonly snapshot: PublicSessionSnapshotV1;
};
type SnapshotRelationJsonlV1<Command extends "show" | "export"> = StructuredHeaderV1<
  Command,
  "relation"
> & {
  readonly session: SessionRefV1;
  readonly documentDigest: SessionDocumentDigestV1;
  readonly relation: PublicRelationV1;
};
type SnapshotEntryJsonlV1<Command extends "show" | "export"> = StructuredHeaderV1<
  Command,
  "entry"
> & {
  readonly session: SessionRefV1;
  readonly documentDigest: SessionDocumentDigestV1;
  readonly entry: PublicSelectedEntryV1;
};
```

JSONL order is exactly page then sessions for list; page then hits for search; and
session envelope, relations, then entries for show/export. Empty arrays still
exist in JSON. Empty list/search emits one JSONL page; an empty snapshot emits one
session line. `nextCursor`, `firstOrdinal`, and `lastOrdinal` are the only nullable
members and are always present. Every `?` member above is omitted when absent; no
other member may be omitted or serialized as `null`. Counts and byte totals are
non-negative safe integers. `segments.total` and `segmentText.originalUtf8Bytes`
cover all canonical segments/text in the already selected entry window before the
100-segment/text-byte limits; `segments.selected` counts emitted segment records.
`canonicalOmittedSegments` counts emitted `kind: "omitted"` records;
`truncatedTextSegments` counts emitted text records whose `text.truncated` is true;
each entry's `omittedSegmentCount` counts its canonical segments excluded by the
global segment-record limit. JSON nested relation/entry values inherit the one
snapshot identity/digest; every JSONL relation/entry repeats them explicitly.
The 16 MiB aggregate cap is presentation admission around these exact DTOs, not a
schema field: successful structured records contain complete structural strings;
an over-cap result emits no records.

## Changes

1. `src/application/export-session.ts` — add a provider-neutral use case that
   validates the canonical identity, inspects only the Sessions-owned library,
   opens one immutable reader, calls existing `getSession`, and returns a frozen
   public snapshot selected by the default policy or `full`. Absent/unready/corrupt
   library behavior follows show. Never add a source/adapter port or read related
   session bodies.

2. A focused format-neutral selection module under `src/application/`, plus
   `src/application/list-sessions.ts`, `search-sessions.ts`, and
   `show-session.ts` — implement `SelectedTextV1` UTF-8/code-point truncation,
   count/byte accounting, canonical-omission versus presentation-truncation
   metadata, and immutable safe relation/entry/segment selection from the
   foundation projection. After each list/search query returns, map its raw
   `SessionQuerySummary` values to an application result whose optional title is
   the one selected `SelectedTextV1`; do not alter the repository query input,
   output ordering, ranking, support, or cursor. Reuse the same module for export
   and for show's existing entry selection. Human and structured renderers must
   receive these selected application results rather than independently selecting
   raw summary/document titles. Preserve show's first-entry, last-entry,
   total-entry, focused-context, missing-entry, and exit behavior.

3. `src/domain/session-query.ts`,
   `src/infrastructure/sqlite/sqlite-session-query.ts`, and query contracts — add
   the primary matched text segment's canonical content hash to search results by
   decoding the content digest already joined by the query. Before constructing a
   hit, hash the already-joined complete canonical `content.text` and require it to
   match the decoded scheme/digest; a well-formed but incorrect 32-byte digest is
   canonical corruption and must emit no result. Apply excerpt truncation only
   after this verification. Do not reconstruct a full document per hit. Keep
   context records honest excerpts and preserve FTS ranking, support counts,
   linked/adjacent rules, body limits, and cursor fingerprints.

4. `src/cli/structured-output.ts` plus focused JSON and JSONL encoder modules —
   construct every schema-1 DTO from the safe application result with exact
   allowlists, recursively freeze/validate the complete result, then serialize.
   Keep JSON pretty/stable enough for documented examples and JSONL compact with
   exactly one trailing newline per record. Measure final encoded UTF-8 bytes and
   enforce the 16 MiB cap atomically before the first write for every non-full
   machine result. Expose the byte cap only as an internal encoder test seam so
   boundary tests need not allocate 16 MiB. Do not reuse terminal escaping for
   machine text, add Zod/runtime schema dependencies, stringify one giant JCS
   document, or claim JSONL streams directly from SQLite.

5. `src/cli/program.ts`, `src/cli/render.ts`, and `src/cli/run.ts` — split format
   admission into operational (`human|json`), retained-query
   (`human|json|jsonl`), and export (`json|jsonl`) types instead of widening one
   global union. Add query format options, required export format, and `--full`.
   Route human list/search/show and structured DTO builders through the same
   application-selected results. Machine encoders emit the raw selected text plus
   metadata without a display suffix. Human renderers escape that selected text,
   add the visible `… [truncated]` suffix when its metadata is truncated, and keep
   the suffix inside the existing post-escape 8 KiB scalar/heading and 256 KiB
   entry-body caps; an additional encoding expansion can also trigger the same
   visible suffix. Map aggregate machine overflow to the sanitized
   `structured-output-too-large` operational error, exit `1`, stderr guidance, and
   empty stdout. JSON and JSONL write only requested records to stdout. Preserve
   Commander strict usage, `NO_COLOR`, stderr-only diagnostics, exit `0/1/2`,
   leading-dash search grammar, and all existing command defaults.

6. `src/bin/sessions.ts` — compose export directly from index paths/lifecycle and
   the existing reader, like list/search/show. Keep Codex resolution lazy and prove
   export/list/search/show work even when provider configuration is malformed or
   unavailable. `index`, `paths`, and `doctor` retain their intentional source
   behavior.

7. CLI/application/query tests — cover every exact JSON object and JSONL record
   type, empty page/envelope records, stable ordering, null/optional rules,
   JSON-to-JSONL evidence equivalence, same digest across formats and source-state
   changes, present/missing/unknown retained export, default bounds versus full,
   Unicode boundary/accounting, title/entry/relation/segment truncation, relation
   overflow, multi-segment entry accounting, canonical omission markers, exhausted
   budgets, and control characters whose terminal escapes expand beyond raw-byte
   counts; plus non-recursive lineage, linked/non-adjacent tool results,
   mention-only text, same-name/different-namespace calls, missing tool identity,
   primary search content hashes, context excerpt labels, and cursor reuse across
   formats. Add recursive forbidden-field/marker assertions for workspace,
   locators, source metadata, provider roots, attachment/private references, and
   synthetic secrets.
   Seed a matched content row with an exact-length but incorrect digest and prove
   search fails closed as canonical corruption before stdout rather than exporting
   the false hash.
   Prove strict flags/formats, required export format, streams, exits, `NO_COLOR`,
   untrusted control/prompt text, no output before validation failure, and no
   provider resolution or storage creation on read-only absent paths. With the
   injected encoder cap, prove exact success at the boundary, one-byte-over
   operational failure with no partial JSONL, unchanged exact structural values
   below the cap, and `export --full` exemption without a production-sized test
   allocation.

8. `scripts/smoke-m6-workflow.ts` (rename only if the expanded ownership makes its
   old name false), `package.json`, and delivery tests — extend the single shared
   compiled/package workflow rather than adding a second harness. Preserve every
   existing process-boundary branch and assertion, including fresh-read
   non-creation, indexing/query/show, retained missing/unknown state, forget,
   orphan repair, compaction, clear, provider-tree immutability, and the current
   tool-linkage evidence. Add only one narrow structured-output journey to that
   workflow: invoke representative JSON list/search/show and JSONL export through
   the compiled binary and parse the JSONL export line-by-line. Both `smoke:dist`
   and packed-install smoke continue executing the same complete workflow so
   installed-package resolution and command wiring remain covered. The
   no-duplication rule applies only to new structured-output matrices: keep
   bounded-versus-full, digest/evidence equivalence, additional missing/unknown
   permutations, structured linkage edge cases, truncation, and recursive
   forbidden-field matrices in the focused application/CLI tests in item 7. Do
   not delete or weaken existing smoke guarantees while avoiding duplicate new
   ones.

9. `docs/reference/structured-output.md`, `README.md`,
   `docs/reference/cli-contract.md`, `docs/privacy.md`,
   `docs/contributing/architecture.md`, `docs/architecture-memo.md`,
   `docs/contributing/testing.md`, `docs/contributing/commands.md`, and
   `dev/plans/260713-v1-implementation-roadmap.md` — publish the exact schema-1
   field/record/null/truncation contracts, examples, trust warning, bounds,
   `--full`, streams/exits, provider-free behavior, package proof, and digest
   limitations. Mark JSON/JSONL and export current only after implementation.
   Record Markdown as deferred presentation work over this same projection before
   M9/V1, remove `md` from current help, and allow M8 to proceed after this plan
   without implying that Markdown was silently dropped.

## Verify

- Focused application/query/CLI tests for export, selection, content hashes, exact
  DTOs, bounded titles, JSON/JSONL equivalence, grammar, streams, exits, and
  provider non-resolution.
- Focused docs-contract tests for generated help, exact schema examples, current
  versus deferred labels, bounds, trust language, and public/private fields.
- `pnpm build`, `pnpm smoke:dist`, and `pnpm smoke:package` through the one shared
  structured workflow.
- `pnpm check`.

## Boundaries

- No Markdown renderer, Markdown fence/terminal safety design, `--format md`, or
  claim that Markdown is complete. It remains explicit later pre-M9/V1 work.
- No adapter change, Cursor work, public adapter ABI, provider read/probe, network,
  import, clipboard/UI delivery, destination creation, or destination token-limit
  management.
- No raw canonical/private object spreading, workspace/locator/source-metadata
  output, transcript redaction promise, hidden-reasoning recovery, omitted payload
  expansion, relation traversal, or inferred transfer lineage.
- No unbounded default, format-dependent selection, export pagination, low-memory
  streaming promise, query reranking, support-unit/filter/cursor change, or
  per-search-hit full-document read.
- No canonical identity/tool/adapter admission limit introduced for a renderer,
  and no truncation of structural identity or linkage fields; aggregate
  fail-before-output keeps that concern in the delivery layer.
- No output-schema/digest-version coupling, digest-as-identity/authentication claim,
  Zod/runtime validator dependency, telemetry, or new background maintenance.
- Stop if the foundation cannot supply exact last-good attribution and verified
  digest from one immutable snapshot, or if JSON and JSONL would require different
  eligible evidence. Fix the shared contract rather than branching renderers.
