import type { ContentHash } from "./content-hash.ts";
import type { ContentClass } from "./source-type.ts";

export type Actor = "human" | "model" | "tool" | "system" | "unknown";

export type ContentOrigin =
  | "human"
  | "injected"
  | "delegated"
  | "replayed-copied"
  | "model"
  | "tool"
  | "system"
  | "unknown";

export type OriginConfidence = "high" | "medium" | "low" | "unknown";

export interface SourceInstance {
  readonly kind: string;
  readonly instanceId: string;
}

export interface SessionIdentity {
  readonly source: SourceInstance;
  readonly nativeId: string;
}

export interface SourceLocator {
  readonly uri: string;
  readonly recordId?: string;
}

export interface SessionRelation {
  readonly kind: "parent" | "child" | "fork" | "continuation" | "unknown";
  readonly target: SessionIdentity;
  readonly confidence: OriginConfidence;
}

export interface ContentSegmentBase {
  readonly ordinal: number;
  readonly origin: ContentOrigin;
  readonly originConfidence: OriginConfidence;
  readonly sourceMetadata: Readonly<Record<string, string>>;
}

export interface TextContentSegment extends ContentSegmentBase {
  readonly kind: "text";
  readonly text: string;
  readonly contentHash: ContentHash;
}

export interface OmittedContentSegment extends ContentSegmentBase {
  readonly kind: "omitted";
  readonly contentClass: ContentClass;
  readonly sourceType: string;
}

export type ContentSegment = TextContentSegment | OmittedContentSegment;

export interface SegmentOccurrenceKey {
  readonly session: SessionIdentity;
  readonly entryOrdinal: number;
  readonly segmentOrdinal: number;
}

export interface SessionEntry {
  readonly ordinal: number;
  readonly kind: string;
  readonly actor: Actor;
  readonly timestamp?: string;
  readonly relatedEntryOrdinal?: number;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly toolNamespace?: string;
  readonly sourceLocator: SourceLocator;
  readonly content: readonly ContentSegment[];
}

export interface SessionDocument {
  readonly identity: SessionIdentity;
  readonly title?: string;
  readonly workspace?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly relations: readonly SessionRelation[];
  readonly entries: readonly SessionEntry[];
}
