import { isCanonicalTimestamp } from "./canonical-timestamp.ts";
import { contentHashMatches, isContentHash } from "./content-hash.ts";
import { snapshotArray, snapshotPlainRecord, type UnknownRecord } from "./data-snapshot.ts";
import {
  formatSessionIdentity,
  isSessionIdentity,
  sameSessionIdentity,
} from "./session-identity.ts";
import { isCanonicalSourceType, isContentClass } from "./source-type.ts";
import type {
  Actor,
  ContentOrigin,
  ContentSegment,
  LineageCoverage,
  OmittedContentSegment,
  OriginConfidence,
  SessionDocument,
  SessionEntry,
  SessionIdentity,
  SessionRelation,
  SourceLocator,
  TextContentSegment,
} from "./session.ts";

export const MAX_SESSION_VALIDATION_ISSUES = 32;

export type SessionValidationIssueCode =
  | "content-hash-mismatch"
  | "duplicate-relation"
  | "expected-array"
  | "expected-object"
  | "expected-string"
  | "identity-mismatch"
  | "invalid-content-hash"
  | "invalid-entry-reference"
  | "invalid-identity"
  | "invalid-literal"
  | "invalid-object"
  | "invalid-ordinal"
  | "invalid-source-metadata"
  | "invalid-source-type"
  | "invalid-string"
  | "invalid-segment-variant"
  | "invalid-text"
  | "invalid-timestamp"
  | "invalid-tool-identity"
  | "missing-property"
  | "noncontiguous-ordinal"
  | "self-entry-reference"
  | "self-relation"
  | "unexpected-property";

export interface SessionValidationIssue {
  readonly code: SessionValidationIssueCode;
  readonly path: string;
}

export interface SessionValidationOptions {
  readonly expectedIdentity?: SessionIdentity;
}

export type SessionValidationResult =
  | {
      readonly ok: true;
      readonly document: SessionDocument;
    }
  | {
      readonly ok: false;
      readonly issues: readonly SessionValidationIssue[];
      readonly truncated: boolean;
    };

interface IssueCollector {
  readonly issues: SessionValidationIssue[];
  truncated: boolean;
}

export function validateSessionDocument(
  value: unknown,
  options: SessionValidationOptions = {},
): SessionValidationResult {
  try {
    return validateSessionDocumentValue(value, options);
  } catch {
    return {
      ok: false,
      issues: [{ code: "invalid-object", path: "/" }],
      truncated: false,
    };
  }
}

function validateSessionDocumentValue(
  value: unknown,
  options: SessionValidationOptions,
): SessionValidationResult {
  const collector: IssueCollector = { issues: [], truncated: false };
  const root = objectAt(value, "/", SESSION_DOCUMENT_KEYS, collector);
  if (root === undefined) return invalidResult(collector);

  for (const key of ["identity", "lineageCoverage", "relations", "entries"] as const) {
    requireProperty(root, key, `/${key}`, collector);
  }

  const identity = Object.hasOwn(root, "identity")
    ? identityAt(root.identity, "/identity", collector)
    : undefined;
  const title = optionalStringAt(root, "title", "/title", collector);
  const workspace = optionalStringAt(root, "workspace", "/workspace", collector);
  const createdAt = optionalTimestampAt(root, "createdAt", "/createdAt", collector);
  const updatedAt = optionalTimestampAt(root, "updatedAt", "/updatedAt", collector);
  const lineageCoverage = Object.hasOwn(root, "lineageCoverage")
    ? lineageCoverageAt(root.lineageCoverage, "/lineageCoverage", collector)
    : undefined;
  const relations = Object.hasOwn(root, "relations")
    ? relationsAt(root.relations, identity, collector)
    : undefined;
  const entries = Object.hasOwn(root, "entries") ? entriesAt(root.entries, collector) : undefined;

  if (
    identity !== undefined &&
    options.expectedIdentity !== undefined &&
    !sameSessionIdentity(identity, options.expectedIdentity)
  ) {
    addIssue(collector, "identity-mismatch", "/identity");
  }

  if (
    collector.issues.length > 0 ||
    identity === undefined ||
    lineageCoverage === undefined ||
    relations === undefined ||
    entries === undefined
  ) {
    return invalidResult(collector);
  }

  const document: SessionDocument = {
    identity,
    ...(title === undefined ? {} : { title }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    lineageCoverage,
    relations,
    entries,
  };
  return { ok: true, document };
}

const SESSION_DOCUMENT_KEYS = new Set([
  "identity",
  "title",
  "workspace",
  "createdAt",
  "updatedAt",
  "lineageCoverage",
  "relations",
  "entries",
]);
const IDENTITY_KEYS = new Set(["source", "nativeId"]);
const SOURCE_INSTANCE_KEYS = new Set(["kind", "instanceId"]);
const RELATION_KEYS = new Set(["kind", "target", "confidence"]);
const ENTRY_KEYS = new Set([
  "ordinal",
  "kind",
  "actor",
  "timestamp",
  "relatedEntryOrdinal",
  "toolCallId",
  "toolName",
  "toolNamespace",
  "sourceLocator",
  "content",
]);
const LOCATOR_KEYS = new Set(["uri", "recordId"]);
const SEGMENT_KEYS = new Set([
  "kind",
  "ordinal",
  "text",
  "contentHash",
  "contentClass",
  "sourceType",
  "origin",
  "originConfidence",
  "sourceMetadata",
]);

function lineageCoverageAt(
  value: unknown,
  path: string,
  collector: IssueCollector,
): LineageCoverage | undefined {
  if (value === "complete" || value === "unknown") return value;
  addIssue(collector, "invalid-literal", path);
  return undefined;
}

function identityAt(
  value: unknown,
  path: string,
  collector: IssueCollector,
): SessionIdentity | undefined {
  const identity = objectAt(value, path, IDENTITY_KEYS, collector);
  if (identity === undefined) return undefined;
  requireProperty(identity, "source", `${path}/source`, collector);
  requireProperty(identity, "nativeId", `${path}/nativeId`, collector);

  const source = Object.hasOwn(identity, "source")
    ? objectAt(identity.source, `${path}/source`, SOURCE_INSTANCE_KEYS, collector)
    : undefined;
  if (source !== undefined) {
    requireProperty(source, "kind", `${path}/source/kind`, collector);
    requireProperty(source, "instanceId", `${path}/source/instanceId`, collector);
  }

  const kind =
    source !== undefined && Object.hasOwn(source, "kind")
      ? stringAt(source.kind, `${path}/source/kind`, collector)
      : undefined;
  const instanceId =
    source !== undefined && Object.hasOwn(source, "instanceId")
      ? stringAt(source.instanceId, `${path}/source/instanceId`, collector)
      : undefined;
  const nativeId = Object.hasOwn(identity, "nativeId")
    ? stringAt(identity.nativeId, `${path}/nativeId`, collector)
    : undefined;
  if (kind === undefined || instanceId === undefined || nativeId === undefined) return undefined;

  const parsed = { source: { kind, instanceId }, nativeId };
  if (!isSessionIdentity(parsed)) {
    addIssue(collector, "invalid-identity", path);
    return undefined;
  }
  return parsed;
}

function relationsAt(
  value: unknown,
  documentIdentity: SessionIdentity | undefined,
  collector: IssueCollector,
): readonly SessionRelation[] | undefined {
  const snapshot = snapshotArray(value);
  if (!snapshot.ok) {
    addIssue(collector, snapshot.code, "/relations");
    return undefined;
  }

  const relations: SessionRelation[] = [];
  const seen = new Set<string>();
  for (const [index, item] of snapshot.values.entries()) {
    const path = `/relations/${index}`;
    const relation = objectAt(item, path, RELATION_KEYS, collector);
    if (relation === undefined) continue;
    for (const key of ["kind", "target", "confidence"] as const) {
      requireProperty(relation, key, `${path}/${key}`, collector);
    }

    const kind = Object.hasOwn(relation, "kind")
      ? relationKindAt(relation.kind, `${path}/kind`, collector)
      : undefined;
    const target = Object.hasOwn(relation, "target")
      ? identityAt(relation.target, `${path}/target`, collector)
      : undefined;
    const confidence = Object.hasOwn(relation, "confidence")
      ? confidenceAt(relation.confidence, `${path}/confidence`, collector)
      : undefined;
    if (kind === undefined || target === undefined || confidence === undefined) continue;

    if (documentIdentity !== undefined && sameSessionIdentity(documentIdentity, target)) {
      addIssue(collector, "self-relation", path);
    }

    const key = `${kind}:${formatSessionIdentity(target)}`;
    if (seen.has(key)) addIssue(collector, "duplicate-relation", path);
    else seen.add(key);
    relations.push({ kind, target, confidence });
  }
  return relations;
}

function entriesAt(value: unknown, collector: IssueCollector): readonly SessionEntry[] | undefined {
  const snapshot = snapshotArray(value);
  if (!snapshot.ok) {
    addIssue(collector, snapshot.code, "/entries");
    return undefined;
  }

  const entries: SessionEntry[] = [];
  for (const [index, item] of snapshot.values.entries()) {
    const entry = entryAt(item, index, snapshot.values.length, collector);
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

function entryAt(
  value: unknown,
  expectedOrdinal: number,
  entryCount: number,
  collector: IssueCollector,
): SessionEntry | undefined {
  const path = `/entries/${expectedOrdinal}`;
  const entry = objectAt(value, path, ENTRY_KEYS, collector);
  if (entry === undefined) return undefined;
  for (const key of ["ordinal", "kind", "actor", "sourceLocator", "content"] as const) {
    requireProperty(entry, key, `${path}/${key}`, collector);
  }

  const ordinal = Object.hasOwn(entry, "ordinal")
    ? ordinalAt(entry.ordinal, expectedOrdinal, `${path}/ordinal`, collector)
    : undefined;
  const kind = Object.hasOwn(entry, "kind")
    ? stringAt(entry.kind, `${path}/kind`, collector)
    : undefined;
  const actor = Object.hasOwn(entry, "actor")
    ? actorAt(entry.actor, `${path}/actor`, collector)
    : undefined;
  const timestamp = optionalTimestampAt(entry, "timestamp", `${path}/timestamp`, collector);
  const relatedEntryOrdinal = relatedEntryOrdinalAt(
    entry,
    expectedOrdinal,
    entryCount,
    `${path}/relatedEntryOrdinal`,
    collector,
  );
  const toolCallId = optionalStringAt(entry, "toolCallId", `${path}/toolCallId`, collector);
  const toolName = optionalStringAt(entry, "toolName", `${path}/toolName`, collector);
  const toolNamespace = optionalStringAt(
    entry,
    "toolNamespace",
    `${path}/toolNamespace`,
    collector,
  );
  const sourceLocator = Object.hasOwn(entry, "sourceLocator")
    ? locatorAt(entry.sourceLocator, `${path}/sourceLocator`, collector)
    : undefined;
  const content = Object.hasOwn(entry, "content")
    ? segmentsAt(entry.content, expectedOrdinal, collector)
    : undefined;

  if (
    ordinal === undefined ||
    kind === undefined ||
    actor === undefined ||
    sourceLocator === undefined ||
    content === undefined
  ) {
    return undefined;
  }

  if (kind !== "tool-call" && (toolName !== undefined || toolNamespace !== undefined)) {
    addIssue(collector, "invalid-tool-identity", path);
  }
  if (toolNamespace !== undefined && toolName === undefined) {
    addIssue(collector, "invalid-tool-identity", `${path}/toolNamespace`);
  }

  return {
    ordinal,
    kind,
    actor,
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(relatedEntryOrdinal === undefined ? {} : { relatedEntryOrdinal }),
    ...(toolCallId === undefined ? {} : { toolCallId }),
    ...(toolName === undefined ? {} : { toolName }),
    ...(toolNamespace === undefined ? {} : { toolNamespace }),
    sourceLocator,
    content,
  };
}

function locatorAt(
  value: unknown,
  path: string,
  collector: IssueCollector,
): SourceLocator | undefined {
  const locator = objectAt(value, path, LOCATOR_KEYS, collector);
  if (locator === undefined) return undefined;
  requireProperty(locator, "uri", `${path}/uri`, collector);
  const uri = Object.hasOwn(locator, "uri")
    ? stringAt(locator.uri, `${path}/uri`, collector)
    : undefined;
  const recordId = optionalStringAt(locator, "recordId", `${path}/recordId`, collector);
  if (uri === undefined) return undefined;
  return { uri, ...(recordId === undefined ? {} : { recordId }) };
}

function segmentsAt(
  value: unknown,
  entryOrdinal: number,
  collector: IssueCollector,
): readonly ContentSegment[] | undefined {
  const path = `/entries/${entryOrdinal}/content`;
  const snapshot = snapshotArray(value);
  if (!snapshot.ok) {
    addIssue(collector, snapshot.code, path);
    return undefined;
  }

  const segments: ContentSegment[] = [];
  for (const [index, item] of snapshot.values.entries()) {
    const segment = segmentAt(item, entryOrdinal, index, collector);
    if (segment !== undefined) segments.push(segment);
  }
  return segments;
}

function segmentAt(
  value: unknown,
  entryOrdinal: number,
  expectedOrdinal: number,
  collector: IssueCollector,
): ContentSegment | undefined {
  const path = `/entries/${entryOrdinal}/content/${expectedOrdinal}`;
  const segment = objectAt(value, path, SEGMENT_KEYS, collector);
  if (segment === undefined) return undefined;
  for (const key of ["kind", "ordinal", "origin", "originConfidence", "sourceMetadata"] as const) {
    requireProperty(segment, key, `${path}/${key}`, collector);
  }

  const kind = Object.hasOwn(segment, "kind")
    ? segmentKindAt(segment.kind, `${path}/kind`, collector)
    : undefined;
  const ordinal = Object.hasOwn(segment, "ordinal")
    ? ordinalAt(segment.ordinal, expectedOrdinal, `${path}/ordinal`, collector)
    : undefined;
  const origin = Object.hasOwn(segment, "origin")
    ? originAt(segment.origin, `${path}/origin`, collector)
    : undefined;
  const originConfidence = Object.hasOwn(segment, "originConfidence")
    ? confidenceAt(segment.originConfidence, `${path}/originConfidence`, collector)
    : undefined;
  const sourceMetadata = Object.hasOwn(segment, "sourceMetadata")
    ? sourceMetadataAt(segment.sourceMetadata, `${path}/sourceMetadata`, collector)
    : undefined;

  if (
    kind === undefined ||
    ordinal === undefined ||
    origin === undefined ||
    originConfidence === undefined ||
    sourceMetadata === undefined
  ) {
    return undefined;
  }

  const base = { kind, ordinal, origin, originConfidence, sourceMetadata };
  if (kind === "text") {
    requireProperty(segment, "text", `${path}/text`, collector);
    requireProperty(segment, "contentHash", `${path}/contentHash`, collector);
    if (Object.hasOwn(segment, "contentClass") || Object.hasOwn(segment, "sourceType")) {
      addIssue(collector, "invalid-segment-variant", path);
    }
    const text = Object.hasOwn(segment, "text")
      ? textAt(segment.text, `${path}/text`, collector)
      : undefined;
    const contentHash = Object.hasOwn(segment, "contentHash")
      ? hashAt(segment.contentHash, `${path}/contentHash`, collector)
      : undefined;
    if (text !== undefined && contentHash !== undefined && !contentHashMatches(text, contentHash)) {
      addIssue(collector, "content-hash-mismatch", `${path}/contentHash`);
    }
    if (text === undefined || contentHash === undefined) return undefined;
    return { ...base, kind, text, contentHash } satisfies TextContentSegment;
  }

  requireProperty(segment, "contentClass", `${path}/contentClass`, collector);
  requireProperty(segment, "sourceType", `${path}/sourceType`, collector);
  if (Object.hasOwn(segment, "text") || Object.hasOwn(segment, "contentHash")) {
    addIssue(collector, "invalid-segment-variant", path);
  }
  const contentClass = Object.hasOwn(segment, "contentClass")
    ? contentClassAt(segment.contentClass, `${path}/contentClass`, collector)
    : undefined;
  const sourceType = Object.hasOwn(segment, "sourceType")
    ? sourceTypeAt(segment.sourceType, `${path}/sourceType`, collector)
    : undefined;
  if (contentClass === undefined || sourceType === undefined) return undefined;
  return { ...base, kind, contentClass, sourceType } satisfies OmittedContentSegment;
}

function objectAt(
  value: unknown,
  path: string,
  allowedKeys: ReadonlySet<string>,
  collector: IssueCollector,
): UnknownRecord | undefined {
  const snapshot = snapshotPlainRecord(value);
  if (!snapshot.ok) {
    addIssue(collector, snapshot.code, path);
    return undefined;
  }
  if (snapshot.keys.some((key) => typeof key !== "string" || !allowedKeys.has(key))) {
    // Report only the known parent path; provider-owned property names may be sensitive.
    addIssue(collector, "unexpected-property", path);
  }
  return snapshot.record;
}

function requireProperty(
  record: UnknownRecord,
  key: string,
  path: string,
  collector: IssueCollector,
): void {
  if (!Object.hasOwn(record, key)) addIssue(collector, "missing-property", path);
}

function stringAt(value: unknown, path: string, collector: IssueCollector): string | undefined {
  if (typeof value !== "string") {
    addIssue(collector, "expected-string", path);
    return undefined;
  }
  if (!value.isWellFormed()) {
    addIssue(collector, "invalid-string", path);
    return undefined;
  }
  return value;
}

function optionalStringAt(
  record: UnknownRecord,
  key: string,
  path: string,
  collector: IssueCollector,
): string | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  return stringAt(record[key], path, collector);
}

function textAt(value: unknown, path: string, collector: IssueCollector): string | undefined {
  if (typeof value !== "string") {
    addIssue(collector, "expected-string", path);
    return undefined;
  }
  if (!value.isWellFormed()) {
    addIssue(collector, "invalid-text", path);
    return undefined;
  }
  return value;
}

function optionalTimestampAt(
  record: UnknownRecord,
  key: string,
  path: string,
  collector: IssueCollector,
): string | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const timestamp = stringAt(record[key], path, collector);
  if (timestamp === undefined) return undefined;
  if (!isCanonicalTimestamp(timestamp)) {
    addIssue(collector, "invalid-timestamp", path);
    return undefined;
  }
  return timestamp;
}

function ordinalAt(
  value: unknown,
  expected: number,
  path: string,
  collector: IssueCollector,
): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    addIssue(collector, "invalid-ordinal", path);
    return undefined;
  }
  if (value !== expected) {
    addIssue(collector, "noncontiguous-ordinal", path);
    return undefined;
  }
  return value;
}

function relatedEntryOrdinalAt(
  record: UnknownRecord,
  currentOrdinal: number,
  entryCount: number,
  path: string,
  collector: IssueCollector,
): number | undefined {
  if (!Object.hasOwn(record, "relatedEntryOrdinal")) return undefined;
  const value = record.relatedEntryOrdinal;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= entryCount
  ) {
    addIssue(collector, "invalid-entry-reference", path);
    return undefined;
  }
  if (value === currentOrdinal) {
    addIssue(collector, "self-entry-reference", path);
    return undefined;
  }
  return value;
}

function hashAt(
  value: unknown,
  path: string,
  collector: IssueCollector,
): TextContentSegment["contentHash"] | undefined {
  const snapshot = snapshotPlainRecord(value);
  if (snapshot.ok) {
    const contentHash = {
      scheme: snapshot.record.scheme,
      digest: snapshot.record.digest,
    };
    if (
      snapshot.keys.length === 2 &&
      snapshot.keys.every((key) => key === "scheme" || key === "digest") &&
      isContentHash(contentHash)
    ) {
      return contentHash;
    }
  }
  addIssue(collector, "invalid-content-hash", path);
  return undefined;
}

function segmentKindAt(
  value: unknown,
  path: string,
  collector: IssueCollector,
): ContentSegment["kind"] | undefined {
  if (value === "text" || value === "omitted") return value;
  addIssue(collector, "invalid-literal", path);
  return undefined;
}

function contentClassAt(
  value: unknown,
  path: string,
  collector: IssueCollector,
): OmittedContentSegment["contentClass"] | undefined {
  if (isContentClass(value)) return value;
  addIssue(collector, "invalid-literal", path);
  return undefined;
}

function sourceTypeAt(value: unknown, path: string, collector: IssueCollector): string | undefined {
  if (isCanonicalSourceType(value)) return value;
  addIssue(collector, "invalid-source-type", path);
  return undefined;
}

function sourceMetadataAt(
  value: unknown,
  path: string,
  collector: IssueCollector,
): Readonly<Record<string, string>> | undefined {
  const snapshot = snapshotPlainRecord(value);
  if (!snapshot.ok) {
    addIssue(collector, snapshot.code, path);
    return undefined;
  }

  const entries: [string, string][] = [];
  for (const key of snapshot.keys) {
    const metadataValue = snapshot.record[key];
    if (
      typeof key !== "string" ||
      !key.isWellFormed() ||
      typeof metadataValue !== "string" ||
      !metadataValue.isWellFormed()
    ) {
      addIssue(collector, "invalid-source-metadata", path);
      return undefined;
    }
    entries.push([key, metadataValue]);
  }
  return Object.fromEntries(entries);
}

function actorAt(value: unknown, path: string, collector: IssueCollector): Actor | undefined {
  if (isActor(value)) return value;
  addIssue(collector, "invalid-literal", path);
  return undefined;
}

function originAt(
  value: unknown,
  path: string,
  collector: IssueCollector,
): ContentOrigin | undefined {
  if (isOrigin(value)) return value;
  addIssue(collector, "invalid-literal", path);
  return undefined;
}

function confidenceAt(
  value: unknown,
  path: string,
  collector: IssueCollector,
): OriginConfidence | undefined {
  if (isConfidence(value)) return value;
  addIssue(collector, "invalid-literal", path);
  return undefined;
}

function relationKindAt(
  value: unknown,
  path: string,
  collector: IssueCollector,
): SessionRelation["kind"] | undefined {
  if (isRelationKind(value)) return value;
  addIssue(collector, "invalid-literal", path);
  return undefined;
}

function isActor(value: unknown): value is Actor {
  return (
    value === "human" ||
    value === "model" ||
    value === "tool" ||
    value === "system" ||
    value === "unknown"
  );
}

function isOrigin(value: unknown): value is ContentOrigin {
  return (
    value === "human" ||
    value === "injected" ||
    value === "delegated" ||
    value === "replayed-copied" ||
    value === "model" ||
    value === "tool" ||
    value === "system" ||
    value === "unknown"
  );
}

function isConfidence(value: unknown): value is OriginConfidence {
  return value === "high" || value === "medium" || value === "low" || value === "unknown";
}

function isRelationKind(value: unknown): value is SessionRelation["kind"] {
  return (
    value === "parent" ||
    value === "child" ||
    value === "fork" ||
    value === "continuation" ||
    value === "unknown"
  );
}

function addIssue(collector: IssueCollector, code: SessionValidationIssueCode, path: string): void {
  if (collector.issues.length < MAX_SESSION_VALIDATION_ISSUES) {
    collector.issues.push({ code, path });
    return;
  }
  collector.truncated = true;
}

function invalidResult(collector: IssueCollector): SessionValidationResult {
  return {
    ok: false,
    issues: collector.issues,
    truncated: collector.truncated,
  };
}
