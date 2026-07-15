import { createHash } from "node:crypto";

import { writeCanonicalJson } from "./json-canonicalization.ts";
import type { SessionDocument, SessionEntry, ContentSegment } from "./session.ts";

export const PUBLIC_SESSION_DOCUMENT_SCHEMA = "sessions-public-document-v1" as const;
export const SESSION_DOCUMENT_DIGEST_SCHEME = "sha256-sessions-document-jcs-v1" as const;

export interface SessionDocumentDigest {
  readonly scheme: typeof SESSION_DOCUMENT_DIGEST_SCHEME;
  readonly digest: string;
}

export interface PublicSessionDocumentV1 {
  readonly documentSchema: typeof PUBLIC_SESSION_DOCUMENT_SCHEMA;
  readonly title?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly lineageCoverage: "complete" | "unknown";
  readonly relations: readonly PublicSessionRelationV1[];
  readonly entries: readonly PublicSessionEntryV1[];
}

export interface PublicSessionRelationV1 {
  readonly ordinal: number;
  readonly kind: "parent" | "child" | "fork" | "continuation" | "unknown";
  readonly target: {
    readonly source: { readonly kind: string; readonly instanceId: string };
    readonly nativeId: string;
  };
  readonly confidence: "high" | "medium" | "low" | "unknown";
}

export interface PublicSessionEntryV1 {
  readonly ordinal: number;
  readonly kind: string;
  readonly actor: "human" | "model" | "tool" | "system" | "unknown";
  readonly timestamp?: string;
  readonly relatedEntryOrdinal?: number;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly toolNamespace?: string;
  readonly content: readonly PublicContentSegmentV1[];
}

export type PublicContentSegmentV1 =
  | {
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
      readonly text: string;
      readonly contentHash: {
        readonly scheme: "sha256-utf8-v1";
        readonly digest: string;
      };
    }
  | {
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
    };

const SHA_256_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
// Only field-by-field projector outputs may claim this fixed digest scheme.
const projectedDocuments = new WeakSet<object>();

export function projectPublicSessionDocument(document: SessionDocument): PublicSessionDocumentV1 {
  const relations = Object.freeze(
    document.relations.map((relation, ordinal) =>
      Object.freeze({
        ordinal,
        kind: relation.kind,
        target: Object.freeze({
          source: Object.freeze({
            kind: relation.target.source.kind,
            instanceId: relation.target.source.instanceId,
          }),
          nativeId: relation.target.nativeId,
        }),
        confidence: relation.confidence,
      }),
    ),
  );
  const entries = Object.freeze(document.entries.map(projectEntry));

  const projection = Object.freeze({
    documentSchema: PUBLIC_SESSION_DOCUMENT_SCHEMA,
    ...(document.title === undefined ? {} : { title: document.title }),
    ...(document.createdAt === undefined ? {} : { createdAt: document.createdAt }),
    ...(document.updatedAt === undefined ? {} : { updatedAt: document.updatedAt }),
    lineageCoverage: document.lineageCoverage,
    relations,
    entries,
  });
  projectedDocuments.add(projection);
  return projection;
}

export function digestPublicSessionDocument(
  document: PublicSessionDocumentV1,
): SessionDocumentDigest {
  if (!projectedDocuments.has(document)) {
    throw new TypeError("Document digest requires the closed public projection");
  }
  const hash = createHash("sha256");
  writeCanonicalJson(document, (fragment) => hash.update(fragment, "utf8"));
  return Object.freeze({
    scheme: SESSION_DOCUMENT_DIGEST_SCHEME,
    digest: hash.digest("hex"),
  });
}

export function isSessionDocumentDigest(value: unknown): value is SessionDocumentDigest {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 2 ||
      !keys.includes("scheme") ||
      !keys.includes("digest") ||
      keys.some((key) => typeof key !== "string")
    ) {
      return false;
    }

    const scheme = Object.getOwnPropertyDescriptor(value, "scheme");
    const digest = Object.getOwnPropertyDescriptor(value, "digest");
    return (
      scheme !== undefined &&
      "value" in scheme &&
      scheme.enumerable === true &&
      scheme.value === SESSION_DOCUMENT_DIGEST_SCHEME &&
      digest !== undefined &&
      "value" in digest &&
      digest.enumerable === true &&
      typeof digest.value === "string" &&
      SHA_256_DIGEST_PATTERN.test(digest.value)
    );
  } catch {
    return false;
  }
}

export function sameSessionDocumentDigest(left: unknown, right: unknown): boolean {
  return (
    isSessionDocumentDigest(left) &&
    isSessionDocumentDigest(right) &&
    left.scheme === right.scheme &&
    left.digest === right.digest
  );
}

function projectEntry(entry: SessionEntry): PublicSessionEntryV1 {
  const content = Object.freeze(
    entry.content.map((segment, ordinal) => projectContentSegment(segment, ordinal)),
  );
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
  });
}

function projectContentSegment(segment: ContentSegment, ordinal: number): PublicContentSegmentV1 {
  switch (segment.kind) {
    case "text":
      return Object.freeze({
        ordinal,
        kind: "text",
        origin: segment.origin,
        originConfidence: segment.originConfidence,
        text: segment.text,
        contentHash: Object.freeze({
          scheme: segment.contentHash.scheme,
          digest: segment.contentHash.digest,
        }),
      });
    case "omitted":
      return Object.freeze({
        ordinal,
        kind: "omitted",
        origin: segment.origin,
        originConfidence: segment.originConfidence,
        contentClass: segment.contentClass,
        sourceType: segment.sourceType,
      });
  }
}
