import { hashContent } from "../../src/domain/content-hash.ts";
import type {
  ContentOrigin,
  ContentSegment,
  OmittedContentSegment,
  OriginConfidence,
  LineageCoverage,
  SessionDocument,
  SessionEntry,
  SessionIdentity,
  SourceInstance,
} from "../../src/domain/session.ts";

export const TEST_SOURCE_INSTANCE: SourceInstance = {
  kind: "synthetic-future",
  instanceId: "profile/one",
};

export function createTestIdentity(nativeId = "session:one"): SessionIdentity {
  return { source: TEST_SOURCE_INSTANCE, nativeId };
}

export interface TestSegmentOptions {
  readonly ordinal?: number;
  readonly text?: string;
  readonly origin?: ContentOrigin;
  readonly originConfidence?: OriginConfidence;
}

export function createTestSegment(options: TestSegmentOptions = {}): ContentSegment {
  const text = options.text ?? "synthetic session text";
  return {
    kind: "text",
    ordinal: options.ordinal ?? 0,
    text,
    contentHash: hashContent(text),
    origin: options.origin ?? "unknown",
    originConfidence: options.originConfidence ?? "unknown",
    sourceMetadata: { fixture: "synthetic" },
  };
}

export interface TestOmittedSegmentOptions {
  readonly ordinal?: number;
  readonly contentClass?: OmittedContentSegment["contentClass"];
  readonly sourceType?: string;
  readonly origin?: ContentOrigin;
  readonly originConfidence?: OriginConfidence;
}

export function createTestOmittedSegment(
  options: TestOmittedSegmentOptions = {},
): OmittedContentSegment {
  return {
    kind: "omitted",
    ordinal: options.ordinal ?? 0,
    contentClass: options.contentClass ?? "unknown",
    sourceType: options.sourceType ?? "synthetic-omission",
    origin: options.origin ?? "unknown",
    originConfidence: options.originConfidence ?? "unknown",
    sourceMetadata: { fixture: "synthetic" },
  };
}

export interface TestEntryOptions {
  readonly ordinal?: number;
  readonly content?: readonly ContentSegment[];
  readonly relatedEntryOrdinal?: number;
}

export function createTestEntry(options: TestEntryOptions = {}): SessionEntry {
  return {
    ordinal: options.ordinal ?? 0,
    kind: "message",
    actor: "human",
    timestamp: "2026-07-13T12:00:00.000Z",
    ...(options.relatedEntryOrdinal === undefined
      ? {}
      : { relatedEntryOrdinal: options.relatedEntryOrdinal }),
    sourceLocator: { uri: "memory://synthetic/session/transcript", recordId: "entry-0" },
    content: options.content ?? [createTestSegment()],
  };
}

export interface TestDocumentOptions {
  readonly identity?: SessionIdentity;
  readonly entries?: readonly SessionEntry[];
  readonly includeMetadata?: boolean;
  readonly lineageCoverage?: LineageCoverage;
}

export function createTestDocument(options: TestDocumentOptions = {}): SessionDocument {
  const includeMetadata = options.includeMetadata ?? true;
  return {
    identity: options.identity ?? createTestIdentity(),
    ...(includeMetadata
      ? {
          title: "Synthetic session",
          workspace: "/workspace/synthetic",
          createdAt: "2026-07-13T12:00:00.000Z",
          updatedAt: "2026-07-13T12:01:00.000Z",
        }
      : {}),
    lineageCoverage: options.lineageCoverage ?? "unknown",
    relations: [],
    entries: options.entries ?? [createTestEntry()],
  };
}
