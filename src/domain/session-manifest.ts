import { Buffer } from "node:buffer";

import { isCanonicalTimestamp } from "./canonical-timestamp.ts";
import { isSessionDocumentDigest, type SessionDocumentDigest } from "./public-session-document.ts";
import { copySessionCaptureScope, type SessionCaptureScope } from "./session-capture-scope.ts";
import { isSessionIdentity } from "./session-identity.ts";
import {
  createSessionFilter,
  type SessionFilter,
  type SessionFilterInput,
  type SessionSourceState,
} from "./session-query.ts";
import type { SessionRootResolution } from "./session-lineage.ts";
import type { LineageCoverage, SessionIdentity } from "./session.ts";

export const MAX_SESSION_MANIFEST_REVISIONS = 10_000;
export const SESSION_MANIFEST_ORDER = "canonical-identity-v1" as const;

declare const sessionManifestQueryBrand: unique symbol;

export type SessionManifestFilterInput = Omit<SessionFilterInput, "workspace">;
export type SessionManifestFilter = Omit<SessionFilter, "workspace">;

export interface SessionManifestQueryInput {
  readonly filter?: SessionManifestFilterInput;
}

export interface SessionManifestSelection {
  readonly order: typeof SESSION_MANIFEST_ORDER;
  readonly maximumRevisions: typeof MAX_SESSION_MANIFEST_REVISIONS;
  readonly filters: SessionManifestFilter;
}

export interface SessionManifestQuery {
  readonly [sessionManifestQueryBrand]: "SessionManifestQuery";
  readonly filter: SessionManifestFilter;
  readonly selection: SessionManifestSelection;
}

export interface SessionManifestCounts {
  readonly relations: number;
  readonly entries: number;
  readonly segments: number;
  readonly omittedSegments: number;
  readonly textUtf8Bytes: number;
}

export interface SessionManifestRevision {
  readonly session: SessionIdentity;
  readonly documentDigest: SessionDocumentDigest;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly capturedAt: string;
  readonly sourceObservedAt: string;
  readonly sourceState: SessionSourceState;
  readonly freshness: "current" | "stale";
  readonly adapterVersion: string;
  readonly lineageCoverage: LineageCoverage;
  readonly root: SessionRootResolution;
  readonly counts: SessionManifestCounts;
}

export interface SessionManifestResult {
  readonly selection: SessionManifestSelection;
  readonly captureScope: SessionCaptureScope;
  readonly revisions: readonly SessionManifestRevision[];
}

/** Admit a workspace-free, fixed-bound manifest query before library inspection. */
export function createSessionManifestQuery(
  input: SessionManifestQueryInput = {},
): SessionManifestQuery {
  const rawFilter = input.filter ?? {};
  if (hasProperty(rawFilter, "workspace")) {
    throw new TypeError("Session manifest does not accept a workspace filter");
  }
  const admitted = createSessionFilter(rawFilter as SessionFilterInput);
  const filter = Object.freeze({ ...admitted }) as SessionManifestFilter;
  const selection = Object.freeze({
    order: SESSION_MANIFEST_ORDER,
    maximumRevisions: MAX_SESSION_MANIFEST_REVISIONS,
    filters: filter,
  });
  return Object.freeze({ filter, selection }) as SessionManifestQuery;
}

/** Validate and deeply copy one manifest result at a public boundary. */
export function createSessionManifestResult(input: SessionManifestResult): SessionManifestResult {
  const query = createSessionManifestQuery({ filter: input.selection.filters });
  if (
    input.selection.order !== SESSION_MANIFEST_ORDER ||
    input.selection.maximumRevisions !== MAX_SESSION_MANIFEST_REVISIONS
  ) {
    throw new TypeError("Session manifest selection is invalid");
  }
  if (input.revisions.length > MAX_SESSION_MANIFEST_REVISIONS) {
    throw new TypeError("Session manifest contains too many revisions");
  }
  const revisions = input.revisions.map(createSessionManifestRevision);
  for (let index = 1; index < revisions.length; index += 1) {
    if (compareIdentity(revisions[index - 1]!.session, revisions[index]!.session) >= 0) {
      throw new TypeError("Session manifest revisions must use canonical identity order");
    }
  }
  return Object.freeze({
    selection: query.selection,
    captureScope: copySessionCaptureScope(input.captureScope),
    revisions: Object.freeze(revisions),
  });
}

export function createSessionManifestRevision(
  input: SessionManifestRevision,
): SessionManifestRevision {
  const session = copyIdentity(input.session, "Session manifest session is invalid");
  const documentDigest = copyDigest(input.documentDigest);
  const createdAt = optionalTimestamp(input.createdAt, "Session manifest created-at");
  const updatedAt = optionalTimestamp(input.updatedAt, "Session manifest updated-at");
  const capturedAt = requiredTimestamp(input.capturedAt, "Session manifest captured-at");
  const sourceObservedAt = requiredTimestamp(
    input.sourceObservedAt,
    "Session manifest source-observed-at",
  );
  if (!isSourceState(input.sourceState)) {
    throw new TypeError("Session manifest source state is invalid");
  }
  if (input.freshness !== "current" && input.freshness !== "stale") {
    throw new TypeError("Session manifest freshness is invalid");
  }
  if (!isNonEmptyWellFormedString(input.adapterVersion)) {
    throw new TypeError("Session manifest adapter version is invalid");
  }
  if (input.lineageCoverage !== "complete" && input.lineageCoverage !== "unknown") {
    throw new TypeError("Session manifest lineage coverage is invalid");
  }
  const root = copyRoot(input.root);
  const counts = createSessionManifestCounts(input.counts);
  return Object.freeze({
    session,
    documentDigest,
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    capturedAt,
    sourceObservedAt,
    sourceState: input.sourceState,
    freshness: input.freshness,
    adapterVersion: input.adapterVersion,
    lineageCoverage: input.lineageCoverage,
    root,
    counts,
  });
}

export function createSessionManifestCounts(input: SessionManifestCounts): SessionManifestCounts {
  const counts = {
    relations: countAt(input.relations),
    entries: countAt(input.entries),
    segments: countAt(input.segments),
    omittedSegments: countAt(input.omittedSegments),
    textUtf8Bytes: countAt(input.textUtf8Bytes),
  };
  if (counts.omittedSegments > counts.segments) {
    throw new TypeError("Session manifest omitted segments exceed total segments");
  }
  return Object.freeze(counts);
}

function hasProperty(value: object, key: PropertyKey): boolean {
  try {
    return key in value;
  } catch (cause) {
    throw new TypeError("Session manifest filter is invalid", { cause });
  }
}

function copyIdentity(value: unknown, message: string): SessionIdentity {
  if (!isSessionIdentity(value)) throw new TypeError(message);
  return Object.freeze({
    source: Object.freeze({ kind: value.source.kind, instanceId: value.source.instanceId }),
    nativeId: value.nativeId,
  });
}

function copyDigest(value: unknown): SessionDocumentDigest {
  if (!isSessionDocumentDigest(value)) {
    throw new TypeError("Session manifest document digest is invalid");
  }
  return Object.freeze({ scheme: value.scheme, digest: value.digest });
}

function copyRoot(value: SessionRootResolution): SessionRootResolution {
  if (value.kind === "unknown") return Object.freeze({ kind: "unknown" });
  if (value.kind !== "known") throw new TypeError("Session manifest root is invalid");
  return Object.freeze({
    kind: "known",
    root: copyIdentity(value.root, "Session manifest root is invalid"),
  });
}

function requiredTimestamp(value: unknown, label: string): string {
  if (!isCanonicalTimestamp(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function optionalTimestamp(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredTimestamp(value, label);
}

function isSourceState(value: unknown): value is SessionSourceState {
  return value === "present" || value === "missing" || value === "unknown";
}

function isNonEmptyWellFormedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.isWellFormed();
}

function countAt(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Session manifest counts must be non-negative safe integers");
  }
  return value;
}

function compareIdentity(left: SessionIdentity, right: SessionIdentity): number {
  return (
    compareBinary(left.source.kind, right.source.kind) ||
    compareBinary(left.source.instanceId, right.source.instanceId) ||
    compareBinary(left.nativeId, right.nativeId)
  );
}

function compareBinary(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
