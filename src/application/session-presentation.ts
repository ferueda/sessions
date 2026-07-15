import type { SessionQuerySummary } from "../domain/session-query.ts";
import type {
  PublicContentSegmentV1,
  PublicSessionDocumentV1,
  PublicSessionEntryV1,
  PublicSessionRelationV1,
  SessionDocumentDigest,
} from "../domain/public-session-document.ts";
import type { SessionIdentity } from "../domain/session.ts";

export const MAX_SELECTED_TITLE_UTF8_BYTES = 8 * 1_024;
export const MAX_SELECTED_RELATIONS = 50;
export const MAX_SELECTED_ENTRIES = 50;
export const MAX_SELECTED_SEGMENTS = 100;
export const MAX_SELECTED_SEGMENT_TEXT_UTF8_BYTES = 8 * 1_024;
export const MAX_SELECTED_TRANSCRIPT_TEXT_UTF8_BYTES = 256 * 1_024;

export interface SelectedText {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalUtf8Bytes: number;
  readonly emittedUtf8Bytes: number;
}

export interface SelectedSessionSummary {
  readonly identity: SessionIdentity;
  readonly documentDigest: SessionDocumentDigest;
  readonly title?: SelectedText;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly capturedAt: string;
  readonly sourceState: "present" | "missing" | "unknown";
  readonly sourceObservedAt: string;
  readonly adapterVersion: string;
  readonly freshness: "current" | "stale";
}

export interface CountSelection {
  readonly selected: number;
  readonly total: number;
  readonly truncated: boolean;
}

export interface EntrySelection extends CountSelection {
  readonly firstOrdinal: number | null;
  readonly lastOrdinal: number | null;
}

export interface ByteSelection {
  readonly emittedUtf8Bytes: number;
  readonly originalUtf8Bytes: number;
  readonly truncated: boolean;
}

export interface TranscriptSelection {
  readonly mode: "bounded" | "full";
  readonly relations: CountSelection;
  readonly entries: EntrySelection;
  readonly segments: CountSelection;
  readonly segmentText: ByteSelection;
  readonly canonicalOmittedSegments: number;
  readonly truncatedTextSegments: number;
}

export interface SelectedSessionSnapshot extends SelectedSessionSummary {
  readonly lineageCoverage: "complete" | "unknown";
  readonly selection: TranscriptSelection;
}

export type SelectedSessionRelation = PublicSessionRelationV1;

export interface SelectedTextSegment {
  readonly ordinal: number;
  readonly kind: "text";
  readonly origin: PublicContentSegmentV1["origin"];
  readonly originConfidence: PublicContentSegmentV1["originConfidence"];
  readonly text: SelectedText;
  readonly contentHash: {
    readonly scheme: "sha256-utf8-v1";
    readonly digest: string;
  };
}

export interface SelectedOmittedSegment {
  readonly ordinal: number;
  readonly kind: "omitted";
  readonly origin: PublicContentSegmentV1["origin"];
  readonly originConfidence: PublicContentSegmentV1["originConfidence"];
  readonly contentClass: "image" | "resource" | "structured" | "unknown";
  readonly sourceType: string;
}

export type SelectedSessionSegment = SelectedTextSegment | SelectedOmittedSegment;

export interface SelectedSessionEntry {
  readonly ordinal: number;
  readonly kind: string;
  readonly actor: "human" | "model" | "tool" | "system" | "unknown";
  readonly timestamp?: string;
  readonly relatedEntryOrdinal?: number;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly toolNamespace?: string;
  readonly content: readonly SelectedSessionSegment[];
  readonly omittedSegmentCount: number;
}

export interface SelectedSessionTranscript {
  readonly snapshot: SelectedSessionSnapshot;
  readonly relations: readonly SelectedSessionRelation[];
  readonly entries: readonly SelectedSessionEntry[];
}

export function selectText(value: string, maximumUtf8Bytes: number): SelectedText {
  if (typeof value !== "string" || !value.isWellFormed()) {
    throw new TypeError("Selected text must be a well-formed string");
  }
  if (!Number.isSafeInteger(maximumUtf8Bytes) || maximumUtf8Bytes < 0) {
    throw new TypeError("Selected text byte limit must be a non-negative safe integer");
  }

  const originalUtf8Bytes = Buffer.byteLength(value, "utf8");
  if (originalUtf8Bytes <= maximumUtf8Bytes) {
    return Object.freeze({
      text: value,
      truncated: false,
      originalUtf8Bytes,
      emittedUtf8Bytes: originalUtf8Bytes,
    });
  }

  let text = "";
  let emittedUtf8Bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (emittedUtf8Bytes + characterBytes > maximumUtf8Bytes) break;
    text += character;
    emittedUtf8Bytes += characterBytes;
  }
  return Object.freeze({
    text,
    truncated: true,
    originalUtf8Bytes,
    emittedUtf8Bytes,
  });
}

export function selectSessionSummary(
  summary: SessionQuerySummary,
  mode: "bounded" | "full" = "bounded",
): SelectedSessionSummary {
  return selectSummary(summary, mode, summary);
}

function selectSummary(
  summary: SessionQuerySummary,
  mode: "bounded" | "full",
  documentFields: {
    readonly title?: string;
    readonly createdAt?: string;
    readonly updatedAt?: string;
  },
): SelectedSessionSummary {
  const title =
    documentFields.title === undefined
      ? undefined
      : selectText(
          documentFields.title,
          mode === "full"
            ? Buffer.byteLength(documentFields.title, "utf8")
            : MAX_SELECTED_TITLE_UTF8_BYTES,
        );
  return Object.freeze({
    identity: copyIdentity(summary.identity),
    documentDigest: copyDocumentDigest(summary.documentDigest),
    ...(title === undefined ? {} : { title }),
    ...(documentFields.createdAt === undefined ? {} : { createdAt: documentFields.createdAt }),
    ...(documentFields.updatedAt === undefined ? {} : { updatedAt: documentFields.updatedAt }),
    capturedAt: summary.capturedAt,
    sourceState: summary.sourceState,
    sourceObservedAt: summary.sourceObservedAt,
    adapterVersion: summary.adapterVersion,
    freshness: summary.freshness,
  });
}

export function selectSessionTranscript(input: {
  readonly summary: SessionQuerySummary;
  readonly document: PublicSessionDocumentV1;
  readonly mode: "bounded" | "full";
  readonly entryWindow?: {
    readonly start: number;
    readonly end: number;
  };
}): SelectedSessionTranscript {
  const entryWindow = resolveEntryWindow(input);
  const windowEntries = input.document.entries.slice(entryWindow.start, entryWindow.end);
  const relations = selectRelations(input.document.relations, input.mode);
  const selectedEntries = selectEntries(windowEntries, input.mode);
  const summary = selectSummary(input.summary, input.mode, input.document);
  const selection = Object.freeze({
    mode: input.mode,
    relations: countSelection(relations.length, input.document.relations.length),
    entries: entrySelection(windowEntries, input.document.entries.length),
    segments: countSelection(selectedEntries.segmentCount, selectedEntries.totalSegmentCount),
    segmentText: byteSelection(selectedEntries.emittedTextBytes, selectedEntries.originalTextBytes),
    canonicalOmittedSegments: selectedEntries.canonicalOmittedSegments,
    truncatedTextSegments: selectedEntries.truncatedTextSegments,
  }) satisfies TranscriptSelection;

  return Object.freeze({
    snapshot: Object.freeze({
      ...summary,
      lineageCoverage: input.document.lineageCoverage,
      selection,
    }),
    relations,
    entries: selectedEntries.entries,
  });
}

function resolveEntryWindow(input: {
  readonly document: PublicSessionDocumentV1;
  readonly mode: "bounded" | "full";
  readonly entryWindow?: { readonly start: number; readonly end: number };
}): { readonly start: number; readonly end: number } {
  if (input.entryWindow === undefined) {
    return {
      start: 0,
      end:
        input.mode === "full"
          ? input.document.entries.length
          : Math.min(input.document.entries.length, MAX_SELECTED_ENTRIES),
    };
  }
  const { start, end } = input.entryWindow;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end > input.document.entries.length
  ) {
    throw new TypeError("Selected entry window is invalid");
  }
  return { start, end };
}

function selectRelations(
  relations: readonly PublicSessionRelationV1[],
  mode: "bounded" | "full",
): readonly SelectedSessionRelation[] {
  const limit = mode === "full" ? relations.length : MAX_SELECTED_RELATIONS;
  return Object.freeze(relations.slice(0, limit).map(copyRelation));
}

function selectEntries(
  entries: readonly PublicSessionEntryV1[],
  mode: "bounded" | "full",
): SelectedEntries {
  let remainingTextBytes =
    mode === "full" ? Number.MAX_SAFE_INTEGER : MAX_SELECTED_TRANSCRIPT_TEXT_UTF8_BYTES;
  let selectedSegmentCount = 0;
  let totalSegmentCount = 0;
  let originalTextBytes = 0;
  let emittedTextBytes = 0;
  let canonicalOmittedSegments = 0;
  let truncatedTextSegments = 0;

  const selectedEntries = entries.map((entry) => {
    const content: SelectedSessionSegment[] = [];
    let omittedSegmentCount = 0;
    for (const segment of entry.content) {
      totalSegmentCount = safeAdd(totalSegmentCount, 1, "segment count");
      if (segment.kind === "text") {
        originalTextBytes = safeAdd(
          originalTextBytes,
          Buffer.byteLength(segment.text, "utf8"),
          "segment text bytes",
        );
      }

      if (mode !== "full" && selectedSegmentCount >= MAX_SELECTED_SEGMENTS) {
        omittedSegmentCount = safeAdd(omittedSegmentCount, 1, "omitted segment count");
        continue;
      }

      const selected = selectSegment(segment, mode, remainingTextBytes);
      content.push(selected.segment);
      selectedSegmentCount = safeAdd(selectedSegmentCount, 1, "selected segment count");
      emittedTextBytes = safeAdd(
        emittedTextBytes,
        selected.emittedTextBytes,
        "emitted segment text bytes",
      );
      remainingTextBytes -= selected.emittedTextBytes;
      if (selected.segment.kind === "omitted") {
        canonicalOmittedSegments = safeAdd(
          canonicalOmittedSegments,
          1,
          "canonical omitted segment count",
        );
      } else if (selected.segment.text.truncated) {
        truncatedTextSegments = safeAdd(truncatedTextSegments, 1, "truncated text segment count");
      }
    }
    return copyEntry(entry, Object.freeze(content), omittedSegmentCount);
  });

  return {
    entries: Object.freeze(selectedEntries),
    segmentCount: selectedSegmentCount,
    totalSegmentCount,
    emittedTextBytes,
    originalTextBytes,
    canonicalOmittedSegments,
    truncatedTextSegments,
  };
}

function selectSegment(
  segment: PublicContentSegmentV1,
  mode: "bounded" | "full",
  remainingTextBytes: number,
): { readonly segment: SelectedSessionSegment; readonly emittedTextBytes: number } {
  if (segment.kind === "omitted") {
    return {
      segment: Object.freeze({
        ordinal: segment.ordinal,
        kind: segment.kind,
        origin: segment.origin,
        originConfidence: segment.originConfidence,
        contentClass: segment.contentClass,
        sourceType: segment.sourceType,
      }),
      emittedTextBytes: 0,
    };
  }

  const text = selectText(
    segment.text,
    mode === "full"
      ? Buffer.byteLength(segment.text, "utf8")
      : Math.min(MAX_SELECTED_SEGMENT_TEXT_UTF8_BYTES, remainingTextBytes),
  );
  return {
    segment: Object.freeze({
      ordinal: segment.ordinal,
      kind: segment.kind,
      origin: segment.origin,
      originConfidence: segment.originConfidence,
      text,
      contentHash: Object.freeze({
        scheme: segment.contentHash.scheme,
        digest: segment.contentHash.digest,
      }),
    }),
    emittedTextBytes: text.emittedUtf8Bytes,
  };
}

function copyEntry(
  entry: PublicSessionEntryV1,
  content: readonly SelectedSessionSegment[],
  omittedSegmentCount: number,
): SelectedSessionEntry {
  return Object.freeze({
    ordinal: entry.ordinal,
    kind: entry.kind,
    actor: entry.actor,
    ...(entry.timestamp === undefined ? {} : { timestamp: entry.timestamp }),
    ...(entry.relatedEntryOrdinal === undefined
      ? {}
      : { relatedEntryOrdinal: entry.relatedEntryOrdinal }),
    ...(entry.toolCallId === undefined ? {} : { toolCallId: entry.toolCallId }),
    ...(entry.toolName === undefined ? {} : { toolName: entry.toolName }),
    ...(entry.toolNamespace === undefined ? {} : { toolNamespace: entry.toolNamespace }),
    content,
    omittedSegmentCount,
  });
}

function copyRelation(relation: PublicSessionRelationV1): SelectedSessionRelation {
  return Object.freeze({
    ordinal: relation.ordinal,
    kind: relation.kind,
    target: copyIdentity(relation.target),
    confidence: relation.confidence,
  });
}

function copyIdentity(identity: SessionIdentity): SessionIdentity {
  return Object.freeze({
    source: Object.freeze({
      kind: identity.source.kind,
      instanceId: identity.source.instanceId,
    }),
    nativeId: identity.nativeId,
  });
}

function copyDocumentDigest(digest: SessionDocumentDigest): SessionDocumentDigest {
  return Object.freeze({ scheme: digest.scheme, digest: digest.digest });
}

function countSelection(selected: number, total: number): CountSelection {
  return Object.freeze({ selected, total, truncated: selected < total });
}

function entrySelection(entries: readonly PublicSessionEntryV1[], total: number): EntrySelection {
  return Object.freeze({
    ...countSelection(entries.length, total),
    firstOrdinal: entries.at(0)?.ordinal ?? null,
    lastOrdinal: entries.at(-1)?.ordinal ?? null,
  });
}

function byteSelection(emittedUtf8Bytes: number, originalUtf8Bytes: number): ByteSelection {
  return Object.freeze({
    emittedUtf8Bytes,
    originalUtf8Bytes,
    truncated: emittedUtf8Bytes < originalUtf8Bytes,
  });
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new RangeError(`Selected ${label} exceeds safe range`);
  return result;
}

interface SelectedEntries {
  readonly entries: readonly SelectedSessionEntry[];
  readonly segmentCount: number;
  readonly totalSegmentCount: number;
  readonly emittedTextBytes: number;
  readonly originalTextBytes: number;
  readonly canonicalOmittedSegments: number;
  readonly truncatedTextSegments: number;
}
