# Structured output contract

- Status: current schema 1 behavior
- Last updated: 2026-07-15

This reference owns the machine-readable output of `sessions list`,
`sessions search`, `sessions show`, and `sessions export`. JSON is one bundle.
JSONL is one compact JSON object per physical line, with one trailing newline per
record. Embedded newlines are JSON escapes, so they never split a JSONL record.
For a command result, JSON and JSONL encode the same eligible evidence, selection,
and persisted document digest.

Pre-alpha schemas may reset before publication. Compatibility starts with the
first published contract. Removing a field, changing a field's meaning, or
changing the record inventory requires a later schema version.

## Commands and trust boundary

```text
sessions list [filters] [--limit N] [--cursor TOKEN]
              [--format human|json|jsonl]
sessions search <text> [filters] [--limit N] [--context N] [--cursor TOKEN]
                       [--format human|json|jsonl]
sessions show <canonical-id> [--entry N --context N]
                             [--format human|json|jsonl]
sessions export <canonical-id> --format json|jsonl [--full]
```

List, search, and show default to `human`. Export requires `--format json` or
`--format jsonl`; omitting it is invalid usage. `md`, YAML, unsupported formats,
unknown flags, and invalid option combinations exit `2`.

Every structured record has `schemaVersion: 1`, a command, a record type, and
`disposition: "untrusted-history"`. Transcript text is faithful historical data,
not an instruction to execute. JSON escaping protects JSON syntax; it does not
make transcript text safe, trusted, or secret-free. Sessions does not redact
secrets, local paths, prompt-like text, or control characters that occur inside
faithfully retained transcript text.

These commands read only the Sessions-owned canonical library. They do not
resolve, probe, or reopen an adapter; contact a provider; follow relation targets;
import an artifact; write a destination; use the clipboard or another app; or
infer lineage from equal text or equal digests. Export reads one retained
snapshot. A retained `missing` or `unknown` source state does not prevent export.
Export has no cursor, does not auto-expand linked calls/results, and never reads
a related session body. Show has no `--full`; it always uses bounded selection.

The `sha256-sessions-document-jcs-v1` digest covers the complete, unbounded
canonical public projection through RFC 8785/JCS, using exact well-formed Unicode
without normalization. Presentation selection and truncation do not change it.
It is stable across root identity, output formats, and later source-state
observations, but it is not identity, authentication, a signature, proof of
safety, or proof of lineage.

## Atomic output and encoded-size limit

Sessions builds and validates the complete result before the first stdout write.
Corruption or encoding failure cannot leave a successful-looking partial JSON or
JSONL result.

JSONL is independently parseable, but schema 1 does not promise low-memory
streaming. Canonical show/export reads already materialize one retained document,
and Sessions validates and encodes the complete result before stdout.

Every JSON/JSONL list, search, show, and default export result has an exact
16 MiB (`16 * 1024 * 1024` UTF-8 bytes) encoded-output limit. Measurement covers
the complete serialized JSON or joined JSONL records, including escaping,
formatting, record newlines, and truncation metadata. A result at the limit
succeeds. One byte over fails with `structured-output-too-large`, exits `1`,
writes no stdout, and advises narrowing list/search or using `export --full`.
Structural strings are never shortened to fit the limit.

`export --full` is the only structured route exempt from this presentation cap.
It means every export-eligible field from the one retained snapshot, not raw
provider data. It cannot recover hidden reasoning, omitted media or references,
related-session bodies, earlier provider revisions, or evidence the adapter did
not retain.

Format does not enter list/search query fingerprints. The same opaque cursor can
continue the same query in human, JSON, or JSONL format. An empty list or search
still emits a page record and exits `0`. An absent show or export exits `1`.

## Selection and bounds

Selection happens once before human, JSON, or JSONL rendering. Array order and
JSONL record order are semantic. Object-key order is deterministic but is not
semantic.

Titles use `SelectedTextV1`. A present bounded title is truncated at a
well-formed Unicode code-point boundary to at most 8 KiB of raw UTF-8 and always
includes all four selection fields. An absent title is omitted, never `null`.
Full export emits the complete title with equal original/emitted byte counts and
`truncated: false`.

Show first keeps its existing entry window: the first 50 entries, or a focused
entry and its requested context. It then applies the default snapshot bounds:

- first 50 ordered relations;
- first 100 segments across the selected entries;
- at most 8 KiB raw UTF-8 per text segment;
- at most 256 KiB raw UTF-8 across emitted segment text;
- at most 8 KiB raw UTF-8 for the title.

Default export selects one contiguous prefix in canonical order with the same
bounds plus the first 50 entries. Entry timestamps never reorder evidence. The
title has its own budget and does not consume the segment-text budget.

Relations, entries, and segments are processed in canonical order. An omitted
canonical segment uses a segment slot but no text bytes. An entry already
selected for show/export remains as a structural record even when its segments
are excluded or its text budget is exhausted. A retained text segment with no
remaining text budget has empty selected text, `truncated: true`, and its full
canonical content hash. Segments beyond the 100-record limit are omitted and
counted. Structural values—identities, ordinals, timestamps, hashes, relation
targets, tool/linkage fields, segment kinds, origins, and confidence—remain exact.

All truncation is at a well-formed Unicode code-point boundary. Byte counts are
raw UTF-8 counts before JSON escaping. Human output applies a second terminal
safety layer after escaping: at most 8 KiB per rendered scalar/heading and
256 KiB per rendered entry body, including separators and visible markers. This
can display less text than JSON/JSONL when escaping expands. Structured metadata
describes only the shared raw selection.

Search keeps its existing ranking, limit, cursor, 512-byte excerpt, context, and
support rules. Context records are explicitly `entry-excerpt` values; they are
not complete canonical entries or segments. Each primary hit includes the full
canonical content hash of its matched segment.

## Exact schema 1

The following closed types are authoritative. A field marked `?` is omitted when
absent. No other field may be omitted or serialized as `null`.

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

### JSON bundles

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

### JSONL records

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

## Nulls, omissions, counts, and order

`nextCursor`, `firstOrdinal`, and `lastOrdinal` are the only nullable members and
are always present. Optional title/provider timestamp/tool fields are omitted
when absent. All other members are required. Counts and byte totals are
non-negative safe integers.

JSONL order is exactly:

- list: one `page`, then ordered `session` records;
- search: one `page`, then ordered `hit` records;
- show/export: one `session` envelope, then ordered `relation` records, then
  ordered `entry` records.

Empty arrays remain present in JSON. Empty list/search emits one JSONL page. An
empty show/export snapshot emits one JSONL session envelope. Each JSONL
relation/entry repeats the session reference and document digest, so it remains
attributable without prior lines. Nested JSON relations/entries inherit the one
snapshot identity and digest.

`segments.total` and `segmentText.originalUtf8Bytes` cover all canonical
segments/text in the selected entry window before global segment/text limits.
`segments.selected` counts emitted segment records.
`canonicalOmittedSegments` counts emitted `kind: "omitted"` records.
`truncatedTextSegments` counts emitted text records whose `text.truncated` is
true. Each entry's `omittedSegmentCount` counts its canonical segments excluded
by the global segment-record limit.

## Minimal examples

An empty list JSON result is still a page:

```json
{
  "schemaVersion": 1,
  "command": "list",
  "type": "page",
  "disposition": "untrusted-history",
  "nextCursor": null,
  "sessions": []
}
```

The equivalent JSONL result is one independently parseable line:

```text
{"schemaVersion":1,"command":"list","type":"page","disposition":"untrusted-history","sessionCount":0,"nextCursor":null}
```

Every show/export JSONL sequence begins with the session envelope. A
relation or entry line then repeats `session` and `documentDigest`; consumers do
not need to retain a preceding line to attribute it.

## Excluded fields and later work

DTOs are built field by field. They never spread raw canonical, query, adapter,
or SQLite values. Root workspace, diagnostic/source/input locators, provider
roots, source metadata, attachment paths, private media references, capture
internals, and raw omitted payloads are excluded as metadata. Omitted non-text
content exposes only its admitted class and source-type token.

Markdown is not a current format and `--format md` is invalid usage. Any post-V1
presentation layer must use the same selected projection and may not change
eligible evidence or digest semantics.
