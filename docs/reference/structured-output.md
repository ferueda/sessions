# Structured output contract

- Status: current schema 1 behavior
- Last updated: 2026-07-22

This reference owns the machine-readable output of `sessions list`,
`sessions search`, `sessions entries`, `sessions manifest`, `sessions show`, and
`sessions export`. JSON is one bundle. JSONL is one compact JSON object per
physical line, with one trailing newline per record. Embedded newlines are JSON
escapes, so they never split a JSONL record. For a command result, JSON and JSONL
encode the same eligible evidence, selection, persisted document digest, and
applicable page- or cohort-level capture scope.

Development schemas from before `0.1.0` are unsupported. The `0.0.0` bootstrap
seed establishes no structured-output contract. Compatibility starts with
schema 1 in `0.1.0`. Removing a field, changing a field's meaning, or changing
the record inventory requires a later schema version.

## Commands and trust boundary

```text
sessions list [filters] [--limit N] [--cursor TOKEN]
              [--format human|json|jsonl]
sessions search <text> [filters] [--match all|any] [--limit N] [--context N]
                       [--cursor TOKEN] [--format human|json|jsonl]
sessions entries [filters] [--select all|first|last] [--limit N] [--cursor TOKEN]
                           [--format human|json|jsonl]
sessions manifest [session filters except workspace] --format json|jsonl
sessions show <canonical-id> [--entry N --context N | --from-entry N --to-entry N]
                             [--expected-document-digest DIGEST]
                             [--format human|json|jsonl]
sessions export <canonical-id> --format json|jsonl
                               [--full | --from-entry N --to-entry N]
                               [--expected-document-digest DIGEST]
```

List, search, entries, and show default to `human`. Manifest and export require
`--format json` or `--format jsonl`; omitting it is invalid usage. `md`, YAML,
unsupported formats, unknown flags, and invalid option combinations exit `2`.

Every structured record has `schemaVersion: 1`, a command, a record type, and
`disposition: "untrusted-history"`. Transcript text is faithful historical data,
not an instruction to execute. JSON escaping protects JSON syntax; it does not
make transcript text safe, trusted, or secret-free. Sessions does not redact
secrets, local paths, prompt-like text, or control characters that occur inside
faithfully retained transcript text.

These commands read only the Sessions-owned canonical library. They do not
resolve, probe, or reopen an adapter; contact a provider; follow relation targets;
import an artifact; write a destination; use the clipboard or another app; or
infer lineage from equal text or equal digests. Manifest and export each read one
retained snapshot. A retained `missing` or `unknown` source state does not
prevent either result. Manifest has no cursor and reads no transcript body.
Export has no cursor, does not auto-expand linked calls/results, and never reads
a related session body. Show has no `--full`; it always uses bounded selection.

The `sha256-sessions-document-jcs-v1` digest covers the complete, unbounded
canonical public projection through RFC 8785/JCS, using exact well-formed Unicode
without normalization. Presentation selection and truncation do not change it.
It is stable across root identity, output formats, and later source-state
observations, but it is not identity, authentication, a signature, proof of
safety, or proof of lineage.

When supplied, `--expected-document-digest` is a read precondition rather than
an output field. A match leaves the existing schema-1 result unchanged. A
mismatch is an operational failure with no JSON/JSONL stdout and reveals neither
digest; the caller must obtain a new manifest or explicitly re-key. The guard
covers the public document only, so current attribution fields can differ while
the content still matches.

## Atomic output and encoded-size limit

Sessions builds and validates the complete result before the first stdout write.
Corruption or encoding failure cannot leave a successful-looking partial JSON or
JSONL result.

JSONL is independently parseable, but schema 1 does not promise low-memory
streaming. Canonical show/export reads already materialize one retained document,
and Sessions validates and encodes the complete result before stdout.

Every JSON/JSONL list, search, entries, manifest, show, and default export result has an exact
16 MiB (`16 * 1024 * 1024` UTF-8 bytes) encoded-output limit. Measurement covers
the complete serialized JSON or joined JSONL records, including escaping,
formatting, record newlines, and truncation metadata. A result at the limit
succeeds. One byte over fails with `structured-output-too-large`, exits `1`,
writes no stdout, and advises narrowing list/search/entries/manifest or using
`export --full`.
Structural strings are never shortened to fit the limit.

`export --full` is the only structured route exempt from this presentation cap.
It means every export-eligible field from the one retained snapshot, not raw
provider data. It cannot recover hidden reasoning, omitted media or references,
related-session bodies, earlier provider revisions, or evidence the adapter did
not retain.

Format does not enter list/search/entries query fingerprints. The same opaque
cursor can continue the same query in human, JSON, or JSONL format. An empty
list, search, or entries result still emits a page record and exits `0`; an empty
manifest emits one manifest envelope and exits `0`. An absent show or export
exits `1`. A valid expected-document mismatch also exits `1` before output and
before an out-of-document coordinate is assessed.

## Selection and bounds

Selection happens once before human, JSON, or JSONL rendering. Array order and
JSONL record order are semantic. Object-key order is deterministic but is not
semantic.

Manifest selection echoes its normalized active source, instance, native-ID,
source-state, activity/capture/observation time, and canonical-session filter
values under `filters`. It also fixes `order: "canonical-identity-v1"` and
`maximumRevisions: 10000`. Workspace is neither accepted nor emitted. A
successful manifest contains every matching retained canonical revision in
binary source-kind, source-instance, and native-ID order. It is never paged or
truncated; more than 10,000 matches fail before output.

Titles use `SelectedTextV1`. A present bounded title is truncated at a
well-formed Unicode code-point boundary to at most 8 KiB of raw UTF-8 and always
includes all four selection fields. An absent title is omitted, never `null`.
Full export emits the complete title with equal original/emitted byte counts and
`truncated: false`.

Show first keeps its existing entry window: the first 50 entries, or a focused
entry and its requested context. Show/export may instead select one paired,
inclusive `--from-entry`/`--to-entry` range of at most 200 entries. Both
endpoints are required. Ranges never clamp; out-of-document endpoints fail.
Focused show and ranged show are mutually exclusive, as are ranged export and
`--full`. The selected window then uses the default snapshot bounds:

- first 50 ordered relations;
- first 100 segments across the selected entries;
- at most 8 KiB raw UTF-8 per text segment;
- at most 256 KiB raw UTF-8 across emitted segment text;
- at most 8 KiB raw UTF-8 for the title.

Default export selects one contiguous prefix in canonical order with the same
bounds plus the first 50 entries. Entry timestamps never reorder evidence. The
title has its own budget and does not consume the segment-text budget.

Range selection changes only which entries enter bounded presentation. Segment
and text limits can still omit or truncate content inside selected entries. The
document digest always covers the complete retained document. The current
reader reconstructs and validates that complete document before selecting a
range, so a range bounds returned evidence rather than storage read cost. An
optional expected digest is compared after complete validation and before actual
entry bounds; it does not change selection metadata or record inventory.

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

Search keeps its ranking, limit, cursor, 512-byte excerpt, context, and support
rules. Context records are explicitly `entry-excerpt` values; they are not
complete canonical entries or segments. Each primary hit includes the full
canonical content hash of its matched segment, the exact terms that matched that
entry, and a query-derived root.

List, search, entries, and manifest revisions include a query-derived known
retained root or `unknown`. Show and export do not. Root attribution does not
alter the complete document projection or digest.

List, search, and entries include one page-level `captureScope`; manifest
includes one cohort-level `captureScope`. It reports
aggregate evidence availability from registered sources and tracking state, not
another set of retained matches. Source, instance, native-ID, source-state, and
canonical-session filters can be applied to tracking evidence. Active canonical
metadata, entry, actor/origin/tool, time, and search-text filters are listed in
`unassessedFilters`; an unindexed session is never classified as matching or not
matching them. Filter names are reported without values.

Entries keeps binary source kind, source instance, native ID, and canonical
entry-ordinal order. It emits one optional 512-byte UTF-8 preview only after the
page is selected. An origin filter also constrains the preview; omitted-only
matches have no preview.

## Exact schema 1

The following closed types are authoritative. A field marked `?` is omitted when
absent. No other field may be omitted or serialized as `null`.

```ts
type StructuredCommandV1 = "list" | "search" | "entries" | "manifest" | "show" | "export";

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

type PublicSessionRootV1 =
  { readonly kind: "known"; readonly session: SessionRefV1 } | { readonly kind: "unknown" };

interface PublicListSessionV1 extends PublicSessionSummaryV1 {
  readonly root: PublicSessionRootV1;
}

interface ManifestSelectionV1 {
  readonly order: "canonical-identity-v1";
  readonly maximumRevisions: 10000;
  readonly filters: {
    readonly source?: string;
    readonly instance?: string;
    readonly nativeId?: string;
    readonly sourceState?: "present" | "missing" | "unknown";
    readonly activityAfter?: string;
    readonly activityBefore?: string;
    readonly capturedAfter?: string;
    readonly capturedBefore?: string;
    readonly observedAfter?: string;
    readonly observedBefore?: string;
    readonly session?: SessionRefV1;
  };
}

interface ManifestCountsV1 {
  readonly relations: number;
  readonly entries: number;
  readonly segments: number;
  readonly omittedSegments: number;
  readonly textUtf8Bytes: number;
}

interface PublicSessionRevisionV1 {
  readonly session: SessionRefV1;
  readonly documentDigest: SessionDocumentDigestV1;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly capturedAt: string;
  readonly sourceObservedAt: string;
  readonly sourceState: "present" | "missing" | "unknown";
  readonly freshness: "current" | "stale";
  readonly adapterVersion: string;
  readonly lineageCoverage: "complete" | "unknown";
  readonly root: PublicSessionRootV1;
  readonly counts: ManifestCountsV1;
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
  readonly root: PublicSessionRootV1;
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
    readonly matchedTerms: readonly string[];
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

type CaptureScopeFilterNameV1 =
  | "source"
  | "instance"
  | "nativeId"
  | "sourceState"
  | "workspace"
  | "activityAfter"
  | "activityBefore"
  | "capturedAfter"
  | "capturedBefore"
  | "observedAfter"
  | "observedBefore"
  | "session"
  | "entryAfter"
  | "entryBefore"
  | "actor"
  | "origin"
  | "entryKind"
  | "toolName"
  | "toolNamespace"
  | "searchText";

interface SessionCaptureScopeV1 {
  readonly status: "uninitialized" | "complete" | "incomplete";
  readonly trackedSessions: number;
  readonly retainedSessions: { readonly current: number; readonly stale: number };
  readonly unindexedSessions: number;
  readonly sourceState: {
    readonly present: number;
    readonly missing: number;
    readonly unknown: number;
  };
  readonly sourceCoverage: { readonly complete: number; readonly unknown: number };
  readonly latestFailures: {
    readonly unavailable: number;
    readonly unreadable: number;
    readonly malformed: number;
    readonly sourceChanged: number;
    readonly unsupportedFormat: number;
    readonly repositoryWrite: number;
  };
  readonly appliedFilters: readonly CaptureScopeFilterNameV1[];
  readonly unassessedFilters: readonly CaptureScopeFilterNameV1[];
}

interface PublicEntryInventoryV1 {
  readonly session: PublicSessionSummaryV1;
  readonly root: PublicSessionRootV1;
  readonly coordinate: PublicEntryCoordinateV1;
  readonly content: {
    readonly textSegmentCount: number;
    readonly omittedSegmentCount: number;
    readonly unpreviewedTextSegmentCount: number;
    readonly preview?: {
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
    };
  };
}
```

### JSON bundles

```ts
type ListJsonV1 = StructuredHeaderV1<"list", "page"> & {
  readonly nextCursor: string | null;
  readonly captureScope: SessionCaptureScopeV1;
  readonly sessions: readonly PublicListSessionV1[];
};

type SearchJsonV1 = StructuredHeaderV1<"search", "page"> & {
  readonly nextCursor: string | null;
  readonly captureScope: SessionCaptureScopeV1;
  readonly support: SearchSupportV1;
  readonly hits: readonly PublicSearchHitV1[];
};

type EntriesJsonV1 = StructuredHeaderV1<"entries", "page"> & {
  readonly nextCursor: string | null;
  readonly captureScope: SessionCaptureScopeV1;
  readonly entries: readonly PublicEntryInventoryV1[];
};

type ManifestJsonV1 = StructuredHeaderV1<"manifest", "manifest"> & {
  readonly revisionCount: number;
  readonly selection: ManifestSelectionV1;
  readonly captureScope: SessionCaptureScopeV1;
  readonly revisions: readonly PublicSessionRevisionV1[];
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
  readonly captureScope: SessionCaptureScopeV1;
};
type ListSessionJsonlV1 = StructuredHeaderV1<"list", "session"> & {
  readonly summary: PublicListSessionV1;
};

type SearchPageJsonlV1 = StructuredHeaderV1<"search", "page"> & {
  readonly hitCount: number;
  readonly nextCursor: string | null;
  readonly captureScope: SessionCaptureScopeV1;
  readonly support: SearchSupportV1;
};
type SearchHitJsonlV1 = StructuredHeaderV1<"search", "hit"> & {
  readonly hit: PublicSearchHitV1;
};

type EntriesPageJsonlV1 = StructuredHeaderV1<"entries", "page"> & {
  readonly entryCount: number;
  readonly nextCursor: string | null;
  readonly captureScope: SessionCaptureScopeV1;
};
type EntriesEntryJsonlV1 = StructuredHeaderV1<"entries", "entry"> & {
  readonly entry: PublicEntryInventoryV1;
};

type ManifestJsonlV1 = StructuredHeaderV1<"manifest", "manifest"> & {
  readonly revisionCount: number;
  readonly selection: ManifestSelectionV1;
  readonly captureScope: SessionCaptureScopeV1;
};
type ManifestRevisionJsonlV1 = StructuredHeaderV1<"manifest", "revision"> & {
  readonly revision: PublicSessionRevisionV1;
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
are always present. Optional title/provider timestamp/tool/preview fields and
optional manifest filter values are omitted when absent. All other members are
required. Counts and byte totals are non-negative safe integers.

Capture-scope counts obey three exact partitions:
`trackedSessions = retainedSessions.current + retainedSessions.stale +
unindexedSessions`; tracked sessions also equal the sum of the three
`sourceState` counts; and stale plus unindexed sessions equal the sum of the six
`latestFailures` counts. `sourceCoverage` counts registered source instances,
not sessions. `complete` requires at least one applicable source, no unknown
coverage, and no stale or unindexed session in the assessed tracking scope.
`uninitialized` has all-zero evidence counts. `appliedFilters` and
`unassessedFilters` are disjoint, use the union's canonical order, and contain no
filter values.

Roots are required on list sessions, search hits, entry records, and manifest
revisions. Search
`matchedTerms` is required, non-empty, unique, in first-query order, and contains
at most 32 exact query terms.

JSONL order is exactly:

- list: one `page`, then ordered `session` records;
- search: one `page`, then ordered `hit` records;
- entries: one `page`, then ordered `entry` records;
- manifest: one `manifest` envelope, then ordered `revision` records;
- show/export: one `session` envelope, then ordered `relation` records, then
  ordered `entry` records.

Empty arrays remain present in JSON. Empty list/search/entries emits one JSONL
page; an empty manifest emits one JSONL manifest envelope. An empty show/export
snapshot emits one JSONL session envelope. Each JSONL
relation/entry repeats the session reference and document digest, so it remains
attributable without prior lines. Nested JSON relations/entries inherit the one
snapshot identity and digest.

Capture scope appears once in a JSON page/manifest bundle and once in the JSONL
page/manifest envelope. It never repeats on a session, hit, entry, or revision
record.

Manifest counts describe the complete canonical document, not a presentation
window: `relations`, `entries`, and `segments` count canonical occurrences;
`omittedSegments` counts omitted segment occurrences; and `textUtf8Bytes` counts
raw UTF-8 bytes for every text occurrence, excluding title. They are stored
derivatives verified by canonical reads and health, not a fresh transcript scan
performed by manifest.

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
  "captureScope": {
    "status": "uninitialized",
    "trackedSessions": 0,
    "retainedSessions": { "current": 0, "stale": 0 },
    "unindexedSessions": 0,
    "sourceState": { "present": 0, "missing": 0, "unknown": 0 },
    "sourceCoverage": { "complete": 0, "unknown": 0 },
    "latestFailures": {
      "unavailable": 0,
      "unreadable": 0,
      "malformed": 0,
      "sourceChanged": 0,
      "unsupportedFormat": 0,
      "repositoryWrite": 0
    },
    "appliedFilters": [],
    "unassessedFilters": []
  },
  "sessions": []
}
```

The equivalent JSONL result is one independently parseable line:

```text
{"schemaVersion":1,"command":"list","type":"page","disposition":"untrusted-history","sessionCount":0,"nextCursor":null,"captureScope":{"status":"uninitialized","trackedSessions":0,"retainedSessions":{"current":0,"stale":0},"unindexedSessions":0,"sourceState":{"present":0,"missing":0,"unknown":0},"sourceCoverage":{"complete":0,"unknown":0},"latestFailures":{"unavailable":0,"unreadable":0,"malformed":0,"sourceChanged":0,"unsupportedFormat":0,"repositoryWrite":0},"appliedFilters":[],"unassessedFilters":[]}}
```

An empty manifest JSON result still binds its complete selection:

```json
{
  "schemaVersion": 1,
  "command": "manifest",
  "type": "manifest",
  "disposition": "untrusted-history",
  "revisionCount": 0,
  "selection": {
    "order": "canonical-identity-v1",
    "maximumRevisions": 10000,
    "filters": {}
  },
  "captureScope": {
    "status": "uninitialized",
    "trackedSessions": 0,
    "retainedSessions": { "current": 0, "stale": 0 },
    "unindexedSessions": 0,
    "sourceState": { "present": 0, "missing": 0, "unknown": 0 },
    "sourceCoverage": { "complete": 0, "unknown": 0 },
    "latestFailures": {
      "unavailable": 0,
      "unreadable": 0,
      "malformed": 0,
      "sourceChanged": 0,
      "unsupportedFormat": 0,
      "repositoryWrite": 0
    },
    "appliedFilters": [],
    "unassessedFilters": []
  },
  "revisions": []
}
```

An empty entries JSONL result is also one page:

```text
{"schemaVersion":1,"command":"entries","type":"page","disposition":"untrusted-history","entryCount":0,"nextCursor":null,"captureScope":{"status":"uninitialized","trackedSessions":0,"retainedSessions":{"current":0,"stale":0},"unindexedSessions":0,"sourceState":{"present":0,"missing":0,"unknown":0},"sourceCoverage":{"complete":0,"unknown":0},"latestFailures":{"unavailable":0,"unreadable":0,"malformed":0,"sourceChanged":0,"unsupportedFormat":0,"repositoryWrite":0},"appliedFilters":[],"unassessedFilters":[]}}
```

Every show/export JSONL sequence begins with the session envelope. A
relation or entry line then repeats `session` and `documentDigest`; consumers do
not need to retain a preceding line to attribute it.

## Excluded fields and later work

DTOs are built field by field. They never spread raw canonical, query, adapter,
or SQLite values. Workspace, diagnostic/source/input locators, provider
roots, source metadata, attachment paths, private media references, capture
internals, and raw omitted payloads are excluded as metadata. Omitted non-text
content exposes only its admitted class and source-type token.

Manifest additionally excludes title, transcript/excerpts, content hashes, raw
relations, library identity, writer generation, leases, and source
fingerprints. Its normalized selection values are intentionally limited to the
safe non-workspace filter allowlist. The command writes only stdout; durable
artifact storage is the caller's separately authorized responsibility.

List, search, and entry inventory include only a query-derived known root session
reference or an explicit unknown value. They do not expose root workspace or
provider paths. Show, export, and document digests do not include root identity.

Markdown is not a current format and `--format md` is invalid usage. Any post-V1
presentation layer must use the same selected projection and may not change
eligible evidence or digest semantics.
