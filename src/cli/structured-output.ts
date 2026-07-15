import { Buffer } from "node:buffer";

import { isCanonicalTimestamp } from "../domain/canonical-timestamp.ts";
import { formatSessionIdentity, isSessionIdentity } from "../domain/session-identity.ts";
import type { SessionIdentity } from "../domain/session.ts";

export type StructuredCommandV1 = "list" | "search" | "show" | "export";

export interface StructuredHeaderV1<Command extends StructuredCommandV1, Type extends string> {
  readonly schemaVersion: 1;
  readonly command: Command;
  readonly type: Type;
  readonly disposition: "untrusted-history";
}

export interface SessionRefV1 {
  readonly canonicalId: string;
  readonly source: { readonly kind: string; readonly instanceId: string };
  readonly nativeId: string;
}

export interface SessionDocumentDigestV1 {
  readonly scheme: "sha256-sessions-document-jcs-v1";
  readonly digest: string;
}

export interface SelectedTextV1 {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalUtf8Bytes: number;
  readonly emittedUtf8Bytes: number;
}

export interface PublicSessionSummaryV1 {
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

export interface CountSelectionV1 {
  readonly selected: number;
  readonly total: number;
  readonly truncated: boolean;
}

export interface EntrySelectionV1 extends CountSelectionV1 {
  readonly firstOrdinal: number | null;
  readonly lastOrdinal: number | null;
}

export interface ByteSelectionV1 {
  readonly emittedUtf8Bytes: number;
  readonly originalUtf8Bytes: number;
  readonly truncated: boolean;
}

export interface TranscriptSelectionV1 {
  readonly mode: "bounded" | "full";
  readonly relations: CountSelectionV1;
  readonly entries: EntrySelectionV1;
  readonly segments: CountSelectionV1;
  readonly segmentText: ByteSelectionV1;
  readonly canonicalOmittedSegments: number;
  readonly truncatedTextSegments: number;
}

export interface PublicSessionSnapshotV1 extends PublicSessionSummaryV1 {
  readonly lineageCoverage: "complete" | "unknown";
  readonly selection: TranscriptSelectionV1;
}

export interface PublicRelationV1 {
  readonly ordinal: number;
  readonly kind: "parent" | "child" | "fork" | "continuation" | "unknown";
  readonly target: SessionRefV1;
  readonly confidence: "high" | "medium" | "low" | "unknown";
}

export interface PublicEntryCoordinateV1 {
  readonly ordinal: number;
  readonly kind: string;
  readonly actor: "human" | "model" | "tool" | "system" | "unknown";
  readonly timestamp?: string;
  readonly relatedEntryOrdinal?: number;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly toolNamespace?: string;
}

export interface PublicTextSegmentV1 {
  readonly ordinal: number;
  readonly kind: "text";
  readonly origin: ContentOriginV1;
  readonly originConfidence: ConfidenceV1;
  readonly text: SelectedTextV1;
  readonly contentHash: ContentHashV1;
}

export interface PublicOmittedSegmentV1 {
  readonly ordinal: number;
  readonly kind: "omitted";
  readonly origin: ContentOriginV1;
  readonly originConfidence: ConfidenceV1;
  readonly contentClass: "image" | "resource" | "structured" | "unknown";
  readonly sourceType: string;
}

export type PublicSelectedSegmentV1 = PublicTextSegmentV1 | PublicOmittedSegmentV1;

export interface PublicSelectedEntryV1 extends PublicEntryCoordinateV1 {
  readonly content: readonly PublicSelectedSegmentV1[];
  readonly omittedSegmentCount: number;
}

export interface SearchExcerptV1 {
  readonly text: string;
  readonly truncated: boolean;
}

export interface SearchContextExcerptV1 {
  readonly type: "entry-excerpt";
  readonly entry: PublicEntryCoordinateV1;
  readonly excerpt: SearchExcerptV1;
  readonly adjacent: boolean;
  readonly linked: boolean;
}

export interface PublicSearchHitV1 {
  readonly session: PublicSessionSummaryV1;
  readonly entry: PublicEntryCoordinateV1;
  readonly match: {
    readonly segmentOrdinal: number;
    readonly origin: ContentOriginV1;
    readonly originConfidence: ConfidenceV1;
    readonly excerpt: SearchExcerptV1;
    readonly contentHash: ContentHashV1;
    readonly additionalMatchingSegments: number;
  };
  readonly context: readonly SearchContextExcerptV1[];
  readonly linkedContextTruncated: boolean;
}

export interface SearchSupportV1 {
  readonly occurrences: number;
  readonly uniqueContent: number;
  readonly uniqueKnownRoots: number;
  readonly unknownLineageSessions: number;
}

export type ListJsonV1 = StructuredHeaderV1<"list", "page"> & {
  readonly nextCursor: string | null;
  readonly sessions: readonly PublicSessionSummaryV1[];
};

export type SearchJsonV1 = StructuredHeaderV1<"search", "page"> & {
  readonly nextCursor: string | null;
  readonly support: SearchSupportV1;
  readonly hits: readonly PublicSearchHitV1[];
};

export type ShowJsonV1 = SnapshotJsonV1<"show">;
export type ExportJsonV1 = SnapshotJsonV1<"export">;

export type ListPageJsonlV1 = StructuredHeaderV1<"list", "page"> & {
  readonly sessionCount: number;
  readonly nextCursor: string | null;
};

export type ListSessionJsonlV1 = StructuredHeaderV1<"list", "session"> & {
  readonly summary: PublicSessionSummaryV1;
};

export type SearchPageJsonlV1 = StructuredHeaderV1<"search", "page"> & {
  readonly hitCount: number;
  readonly nextCursor: string | null;
  readonly support: SearchSupportV1;
};

export type SearchHitJsonlV1 = StructuredHeaderV1<"search", "hit"> & {
  readonly hit: PublicSearchHitV1;
};

export type SnapshotSessionJsonlV1<Command extends "show" | "export"> = StructuredHeaderV1<
  Command,
  "session"
> & {
  readonly snapshot: PublicSessionSnapshotV1;
};

export type SnapshotRelationJsonlV1<Command extends "show" | "export"> = StructuredHeaderV1<
  Command,
  "relation"
> & {
  readonly session: SessionRefV1;
  readonly documentDigest: SessionDocumentDigestV1;
  readonly relation: PublicRelationV1;
};

export type SnapshotEntryJsonlV1<Command extends "show" | "export"> = StructuredHeaderV1<
  Command,
  "entry"
> & {
  readonly session: SessionRefV1;
  readonly documentDigest: SessionDocumentDigestV1;
  readonly entry: PublicSelectedEntryV1;
};

export type StructuredJsonV1 = ListJsonV1 | SearchJsonV1 | ShowJsonV1 | ExportJsonV1;
export type StructuredJsonlRecordV1 =
  | ListPageJsonlV1
  | ListSessionJsonlV1
  | SearchPageJsonlV1
  | SearchHitJsonlV1
  | SnapshotSessionJsonlV1<"show" | "export">
  | SnapshotRelationJsonlV1<"show" | "export">
  | SnapshotEntryJsonlV1<"show" | "export">;
export type StructuredJsonlV1 = readonly StructuredJsonlRecordV1[];
export type StructuredOutputV1 = StructuredJsonV1 | StructuredJsonlV1;

export interface StructuredSessionSummaryInputV1 {
  readonly identity: SessionIdentity;
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

export interface StructuredListInputV1 {
  readonly sessions: readonly StructuredSessionSummaryInputV1[];
  readonly nextCursor?: string;
}

export interface StructuredSearchInputV1 {
  readonly hits: readonly StructuredSearchHitInputV1[];
  readonly support: SearchSupportV1;
  readonly nextCursor?: string;
}

export interface StructuredSearchHitInputV1 {
  readonly session: StructuredSessionSummaryInputV1;
  readonly entry: PublicEntryCoordinateV1;
  readonly snippet: {
    readonly segmentOrdinal: number;
    readonly origin: ContentOriginV1;
    readonly originConfidence: ConfidenceV1;
    readonly contentHash: ContentHashV1;
    readonly text: string;
    readonly truncated: boolean;
    readonly additionalMatchingSegments: number;
  };
  readonly context: readonly StructuredSearchContextInputV1[];
  readonly linkedContextTruncated: boolean;
}

export interface StructuredSearchContextInputV1 extends PublicEntryCoordinateV1 {
  readonly body: string;
  readonly bodyTruncated: boolean;
  readonly adjacent: boolean;
  readonly linked: boolean;
}

export interface StructuredSnapshotInputV1 {
  readonly snapshot: StructuredSessionSnapshotInputV1;
  readonly relations: readonly StructuredRelationInputV1[];
  readonly entries: readonly PublicSelectedEntryV1[];
}

export interface StructuredSessionSnapshotInputV1 extends StructuredSessionSummaryInputV1 {
  readonly lineageCoverage: "complete" | "unknown";
  readonly selection: TranscriptSelectionV1;
}

export interface StructuredRelationInputV1 {
  readonly ordinal: number;
  readonly kind: "parent" | "child" | "fork" | "continuation" | "unknown";
  readonly target: SessionIdentity;
  readonly confidence: ConfidenceV1;
}

type SnapshotJsonV1<Command extends "show" | "export"> = StructuredHeaderV1<Command, "snapshot"> & {
  readonly snapshot: PublicSessionSnapshotV1;
  readonly relations: readonly PublicRelationV1[];
  readonly entries: readonly PublicSelectedEntryV1[];
};

type ConfidenceV1 = "high" | "medium" | "low" | "unknown";
type ContentOriginV1 =
  | "human"
  | "injected"
  | "delegated"
  | "replayed-copied"
  | "model"
  | "tool"
  | "system"
  | "unknown";
type ContentHashV1 = {
  readonly scheme: "sha256-utf8-v1";
  readonly digest: string;
};

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const builtStructuredOutput = new WeakSet<object>();

export function buildListJsonV1(input: StructuredListInputV1): ListJsonV1 {
  return finalizeStructuredOutput({
    ...header("list", "page"),
    nextCursor: copyCursor(input.nextCursor),
    sessions: input.sessions.map(copySummary),
  });
}

export function buildListJsonlV1(input: StructuredListInputV1): StructuredJsonlV1 {
  const summaries = input.sessions.map(copySummary);
  return finalizeStructuredOutput([
    {
      ...header("list", "page"),
      sessionCount: summaries.length,
      nextCursor: copyCursor(input.nextCursor),
    },
    ...summaries.map((summary) => ({ ...header("list", "session"), summary })),
  ]);
}

export function buildSearchJsonV1(input: StructuredSearchInputV1): SearchJsonV1 {
  return finalizeStructuredOutput({
    ...header("search", "page"),
    nextCursor: copyCursor(input.nextCursor),
    support: copySupport(input.support),
    hits: input.hits.map(copySearchHit),
  });
}

export function buildSearchJsonlV1(input: StructuredSearchInputV1): StructuredJsonlV1 {
  const support = copySupport(input.support);
  const hits = input.hits.map(copySearchHit);
  return finalizeStructuredOutput([
    {
      ...header("search", "page"),
      hitCount: hits.length,
      nextCursor: copyCursor(input.nextCursor),
      support,
    },
    ...hits.map((hit) => ({ ...header("search", "hit"), hit })),
  ]);
}

export function buildSnapshotJsonV1(command: "show", input: StructuredSnapshotInputV1): ShowJsonV1;
export function buildSnapshotJsonV1(
  command: "export",
  input: StructuredSnapshotInputV1,
): ExportJsonV1;
export function buildSnapshotJsonV1(
  command: "show" | "export",
  input: StructuredSnapshotInputV1,
): ShowJsonV1 | ExportJsonV1;
export function buildSnapshotJsonV1(
  command: "show" | "export",
  input: StructuredSnapshotInputV1,
): ShowJsonV1 | ExportJsonV1 {
  const transcript = copyTranscript(input);
  return finalizeStructuredOutput({
    ...header(command, "snapshot"),
    ...transcript,
  });
}

export function buildSnapshotJsonlV1(
  command: "show" | "export",
  input: StructuredSnapshotInputV1,
): StructuredJsonlV1 {
  const { snapshot, relations, entries } = copyTranscript(input);
  return finalizeStructuredOutput([
    { ...header(command, "session"), snapshot },
    ...relations.map((relation) => ({
      ...header(command, "relation"),
      session: snapshot.session,
      documentDigest: snapshot.documentDigest,
      relation,
    })),
    ...entries.map((entry) => ({
      ...header(command, "entry"),
      session: snapshot.session,
      documentDigest: snapshot.documentDigest,
      entry,
    })),
  ]);
}

export function assertBuiltStructuredOutput(value: unknown): asserts value is StructuredOutputV1 {
  if (typeof value !== "object" || value === null || !builtStructuredOutput.has(value)) {
    throw new TypeError("Structured output must be built from a safe application result");
  }
}

function copyTranscript(input: StructuredSnapshotInputV1): {
  readonly snapshot: PublicSessionSnapshotV1;
  readonly relations: readonly PublicRelationV1[];
  readonly entries: readonly PublicSelectedEntryV1[];
} {
  const relations = input.relations.map(copyRelation);
  const entries = input.entries.map(copyEntry);
  const snapshot = copySnapshot(input.snapshot);
  validateTranscriptSelection(snapshot.selection, relations, entries);
  return { snapshot, relations, entries };
}

function copySummary(input: StructuredSessionSummaryInputV1): PublicSessionSummaryV1 {
  return {
    session: copySessionRef(input.identity),
    documentDigest: copyDocumentDigest(input.documentDigest),
    ...(input.title === undefined ? {} : { title: copySelectedText(input.title) }),
    ...(input.createdAt === undefined ? {} : { createdAt: timestamp(input.createdAt) }),
    ...(input.updatedAt === undefined ? {} : { updatedAt: timestamp(input.updatedAt) }),
    capturedAt: timestamp(input.capturedAt),
    sourceState: literal(input.sourceState, ["present", "missing", "unknown"]),
    sourceObservedAt: timestamp(input.sourceObservedAt),
    adapterVersion: exactString(input.adapterVersion),
    freshness: literal(input.freshness, ["current", "stale"]),
  };
}

function copySnapshot(input: StructuredSessionSnapshotInputV1): PublicSessionSnapshotV1 {
  return {
    ...copySummary(input),
    lineageCoverage: literal(input.lineageCoverage, ["complete", "unknown"]),
    selection: copyTranscriptSelection(input.selection),
  };
}

function copySessionRef(identity: SessionIdentity): SessionRefV1 {
  if (!isSessionIdentity(identity)) throw new TypeError("Structured session identity is invalid");
  return {
    canonicalId: formatSessionIdentity(identity),
    source: { kind: identity.source.kind, instanceId: identity.source.instanceId },
    nativeId: identity.nativeId,
  };
}

function copyDocumentDigest(value: SessionDocumentDigestV1): SessionDocumentDigestV1 {
  if (value.scheme !== "sha256-sessions-document-jcs-v1" || !DIGEST_PATTERN.test(value.digest)) {
    throw new TypeError("Structured document digest is invalid");
  }
  return { scheme: value.scheme, digest: value.digest };
}

function copyContentHash(value: ContentHashV1): ContentHashV1 {
  if (value.scheme !== "sha256-utf8-v1" || !DIGEST_PATTERN.test(value.digest)) {
    throw new TypeError("Structured content hash is invalid");
  }
  return { scheme: value.scheme, digest: value.digest };
}

function copySelectedText(value: SelectedTextV1): SelectedTextV1 {
  const text = exactString(value.text);
  const emittedUtf8Bytes = nonNegativeInteger(value.emittedUtf8Bytes);
  const originalUtf8Bytes = nonNegativeInteger(value.originalUtf8Bytes);
  const actualBytes = Buffer.byteLength(text, "utf8");
  if (
    emittedUtf8Bytes !== actualBytes ||
    originalUtf8Bytes < emittedUtf8Bytes ||
    value.truncated !== originalUtf8Bytes > emittedUtf8Bytes
  ) {
    throw new TypeError("Structured text byte accounting is invalid");
  }
  return { text, truncated: boolean(value.truncated), originalUtf8Bytes, emittedUtf8Bytes };
}

function copyRelation(input: StructuredRelationInputV1): PublicRelationV1 {
  return {
    ordinal: nonNegativeInteger(input.ordinal),
    kind: literal(input.kind, ["parent", "child", "fork", "continuation", "unknown"]),
    target: copySessionRef(input.target),
    confidence: copyConfidence(input.confidence),
  };
}

function copyEntry(input: PublicSelectedEntryV1): PublicSelectedEntryV1 {
  return {
    ...copyEntryCoordinate(input),
    content: input.content.map(copySegment),
    omittedSegmentCount: nonNegativeInteger(input.omittedSegmentCount),
  };
}

function copyEntryCoordinate(input: PublicEntryCoordinateV1): PublicEntryCoordinateV1 {
  return {
    ordinal: nonNegativeInteger(input.ordinal),
    kind: exactString(input.kind),
    actor: literal(input.actor, ["human", "model", "tool", "system", "unknown"]),
    ...(input.timestamp === undefined ? {} : { timestamp: timestamp(input.timestamp) }),
    ...(input.relatedEntryOrdinal === undefined
      ? {}
      : { relatedEntryOrdinal: nonNegativeInteger(input.relatedEntryOrdinal) }),
    ...(input.toolCallId === undefined ? {} : { toolCallId: exactString(input.toolCallId) }),
    ...(input.toolName === undefined ? {} : { toolName: exactString(input.toolName) }),
    ...(input.toolNamespace === undefined
      ? {}
      : { toolNamespace: exactString(input.toolNamespace) }),
  };
}

function copySegment(input: PublicSelectedSegmentV1): PublicSelectedSegmentV1 {
  const common = {
    ordinal: nonNegativeInteger(input.ordinal),
    origin: copyOrigin(input.origin),
    originConfidence: copyConfidence(input.originConfidence),
  };
  switch (input.kind) {
    case "text":
      return {
        ...common,
        kind: "text",
        text: copySelectedText(input.text),
        contentHash: copyContentHash(input.contentHash),
      };
    case "omitted":
      return {
        ...common,
        kind: "omitted",
        contentClass: literal(input.contentClass, ["image", "resource", "structured", "unknown"]),
        sourceType: exactString(input.sourceType),
      };
  }
}

function copySearchHit(input: StructuredSearchHitInputV1): PublicSearchHitV1 {
  return {
    session: copySummary(input.session),
    entry: copyEntryCoordinate(input.entry),
    match: {
      segmentOrdinal: nonNegativeInteger(input.snippet.segmentOrdinal),
      origin: copyOrigin(input.snippet.origin),
      originConfidence: copyConfidence(input.snippet.originConfidence),
      excerpt: copyExcerpt(input.snippet.text, input.snippet.truncated),
      contentHash: copyContentHash(input.snippet.contentHash),
      additionalMatchingSegments: nonNegativeInteger(input.snippet.additionalMatchingSegments),
    },
    context: input.context.map((context) => ({
      type: "entry-excerpt",
      entry: copyEntryCoordinate(context),
      excerpt: copyExcerpt(context.body, context.bodyTruncated),
      adjacent: boolean(context.adjacent),
      linked: boolean(context.linked),
    })),
    linkedContextTruncated: boolean(input.linkedContextTruncated),
  };
}

function copyExcerpt(text: string, truncated: boolean): SearchExcerptV1 {
  return { text: exactString(text), truncated: boolean(truncated) };
}

function copySupport(value: SearchSupportV1): SearchSupportV1 {
  return {
    occurrences: nonNegativeInteger(value.occurrences),
    uniqueContent: nonNegativeInteger(value.uniqueContent),
    uniqueKnownRoots: nonNegativeInteger(value.uniqueKnownRoots),
    unknownLineageSessions: nonNegativeInteger(value.unknownLineageSessions),
  };
}

function copyTranscriptSelection(value: TranscriptSelectionV1): TranscriptSelectionV1 {
  return {
    mode: literal(value.mode, ["bounded", "full"]),
    relations: copyCountSelection(value.relations),
    entries: copyEntrySelection(value.entries),
    segments: copyCountSelection(value.segments),
    segmentText: copyByteSelection(value.segmentText),
    canonicalOmittedSegments: nonNegativeInteger(value.canonicalOmittedSegments),
    truncatedTextSegments: nonNegativeInteger(value.truncatedTextSegments),
  };
}

function copyCountSelection(value: CountSelectionV1): CountSelectionV1 {
  const selected = nonNegativeInteger(value.selected);
  const total = nonNegativeInteger(value.total);
  if (selected > total || value.truncated !== selected < total) {
    throw new TypeError("Structured count selection is invalid");
  }
  return { selected, total, truncated: boolean(value.truncated) };
}

function copyEntrySelection(value: EntrySelectionV1): EntrySelectionV1 {
  const count = copyCountSelection(value);
  const firstOrdinal = nullableOrdinal(value.firstOrdinal);
  const lastOrdinal = nullableOrdinal(value.lastOrdinal);
  if (
    (count.selected === 0 && (firstOrdinal !== null || lastOrdinal !== null)) ||
    (count.selected > 0 && (firstOrdinal === null || lastOrdinal === null)) ||
    (firstOrdinal !== null && lastOrdinal !== null && firstOrdinal > lastOrdinal)
  ) {
    throw new TypeError("Structured entry selection is invalid");
  }
  return { ...count, firstOrdinal, lastOrdinal };
}

function copyByteSelection(value: ByteSelectionV1): ByteSelectionV1 {
  const emittedUtf8Bytes = nonNegativeInteger(value.emittedUtf8Bytes);
  const originalUtf8Bytes = nonNegativeInteger(value.originalUtf8Bytes);
  if (
    emittedUtf8Bytes > originalUtf8Bytes ||
    value.truncated !== emittedUtf8Bytes < originalUtf8Bytes
  ) {
    throw new TypeError("Structured byte selection is invalid");
  }
  return { emittedUtf8Bytes, originalUtf8Bytes, truncated: boolean(value.truncated) };
}

function validateTranscriptSelection(
  selection: TranscriptSelectionV1,
  relations: readonly PublicRelationV1[],
  entries: readonly PublicSelectedEntryV1[],
): void {
  const segments = entries.flatMap((entry) => entry.content);
  const textSegments = segments.filter((segment) => segment.kind === "text");
  const firstEntry = entries.at(0);
  const lastEntry = entries.at(-1);
  const omittedByLimit = entries.reduce((total, entry) => total + entry.omittedSegmentCount, 0);
  const emittedTextBytes = textSegments.reduce(
    (total, segment) => total + segment.text.emittedUtf8Bytes,
    0,
  );
  const originalTextBytes = textSegments.reduce(
    (total, segment) => total + segment.text.originalUtf8Bytes,
    0,
  );
  if (
    selection.relations.selected !== relations.length ||
    selection.entries.selected !== entries.length ||
    selection.entries.firstOrdinal !== (firstEntry?.ordinal ?? null) ||
    selection.entries.lastOrdinal !== (lastEntry?.ordinal ?? null) ||
    selection.segments.selected !== segments.length ||
    selection.segments.total - selection.segments.selected !== omittedByLimit ||
    selection.canonicalOmittedSegments !==
      segments.filter((segment) => segment.kind === "omitted").length ||
    selection.truncatedTextSegments !==
      textSegments.filter((segment) => segment.text.truncated).length ||
    selection.segmentText.emittedUtf8Bytes !== emittedTextBytes ||
    selection.segmentText.originalUtf8Bytes < originalTextBytes
  ) {
    throw new TypeError("Structured transcript selection is inconsistent");
  }
}

function header<Command extends StructuredCommandV1, Type extends string>(
  command: Command,
  type: Type,
): StructuredHeaderV1<Command, Type> {
  return { schemaVersion: 1, command, type, disposition: "untrusted-history" };
}

function copyCursor(value: string | undefined): string | null {
  return value === undefined ? null : nonEmptyString(value);
}

function copyConfidence(value: ConfidenceV1): ConfidenceV1 {
  return literal(value, ["high", "medium", "low", "unknown"]);
}

function copyOrigin(value: ContentOriginV1): ContentOriginV1 {
  return literal(value, [
    "human",
    "injected",
    "delegated",
    "replayed-copied",
    "model",
    "tool",
    "system",
    "unknown",
  ]);
}

function nullableOrdinal(value: number | null): number | null {
  return value === null ? null : nonNegativeInteger(value);
}

function timestamp(value: string): string {
  if (!isCanonicalTimestamp(value)) throw new TypeError("Structured timestamp is invalid");
  return value;
}

function exactString(value: string): string {
  if (typeof value !== "string" || !value.isWellFormed()) {
    throw new TypeError("Structured string is invalid");
  }
  return value;
}

function nonEmptyString(value: string): string {
  const exact = exactString(value);
  if (exact.length === 0) throw new TypeError("Structured string must not be empty");
  return exact;
}

function nonNegativeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Structured number must be a non-negative safe integer");
  }
  return value;
}

function boolean(value: boolean): boolean {
  if (typeof value !== "boolean") throw new TypeError("Structured boolean is invalid");
  return value;
}

function literal<const Value extends string>(value: Value, allowed: readonly Value[]): Value {
  if (!allowed.includes(value)) throw new TypeError("Structured literal is invalid");
  return value;
}

function finalizeStructuredOutput<T extends object>(value: T): T {
  validateAndFreezeJson(value, new Set());
  builtStructuredOutput.add(value);
  return value;
}

function validateAndFreezeJson(value: unknown, ancestors: Set<object>): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    exactString(value);
    return;
  }
  if (typeof value === "number") {
    nonNegativeInteger(value);
    return;
  }
  if (typeof value !== "object") throw new TypeError("Structured output is not JSON-safe");
  if (ancestors.has(value)) throw new TypeError("Structured output must not contain cycles");
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new TypeError("Structured output arrays must not be sparse");
      validateAndFreezeJson(value[index], ancestors);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Structured output objects must be plain");
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new TypeError("Structured output keys must be strings");
      exactString(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError("Structured output properties must be enumerable data values");
      }
      validateAndFreezeJson(descriptor.value, ancestors);
    }
  }
  ancestors.delete(value);
  Object.freeze(value);
}
