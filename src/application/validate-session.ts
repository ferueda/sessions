import type {
  DiscoveredSession,
  SelectedSessionSource,
  SessionSource,
  SourceInputAggregateFingerprint,
  SourceInputDescriptor,
} from "./ports/session-source.ts";
import { fingerprintSourceInputs } from "./source-input-fingerprint.ts";
import { snapshotArray, snapshotPlainRecord, type UnknownRecord } from "../domain/data-snapshot.ts";
import {
  validateSessionDocument,
  type SessionValidationIssue,
} from "../domain/session-validation.ts";
import { isSessionIdentity } from "../domain/session-identity.ts";
import {
  digestPublicSessionDocument,
  projectPublicSessionDocument,
  type SessionDocumentDigest,
} from "../domain/public-session-document.ts";
import type { SessionDocument, SessionIdentity, SourceInstance } from "../domain/session.ts";

const observationBrand: unique symbol = Symbol("SessionObservation");
const admittedCandidateBrand: unique symbol = Symbol("AdmittedDiscoveredSession");
const replacementBrand: unique symbol = Symbol("ValidatedSessionReplacement");

export interface SessionRevision {
  readonly aggregateFingerprint: SourceInputAggregateFingerprint;
  readonly adapterVersion: string;
}

export interface SessionObservation {
  readonly [observationBrand]: true;
  readonly identity: SessionIdentity;
  readonly revision: SessionRevision;
}

export interface AdmittedDiscoveredSession {
  readonly [admittedCandidateBrand]: true;
  readonly candidate: DiscoveredSession;
  readonly observation: SessionObservation;
}

export interface ValidatedSessionReplacement {
  readonly [replacementBrand]: true;
  readonly observation: SessionObservation;
  readonly document: SessionDocument;
  readonly documentDigest: SessionDocumentDigest;
}

export type SessionObservationIssueCode =
  | "invalid-candidate"
  | "invalid-adapter-version"
  | "invalid-aggregate-fingerprint"
  | "invalid-identity"
  | "invalid-input"
  | "invalid-inputs";

export interface SessionObservationIssue {
  readonly code: SessionObservationIssueCode;
  readonly path: string;
}

export type SessionObservationAdmissionResult =
  | { readonly ok: true; readonly observation: SessionObservation }
  | {
      readonly ok: false;
      readonly issues: readonly SessionObservationIssue[];
      readonly truncated: boolean;
    };

export type DiscoveredSessionAdmissionResult =
  | { readonly ok: true; readonly admitted: AdmittedDiscoveredSession }
  | {
      readonly ok: false;
      readonly issues: readonly SessionObservationIssue[];
      readonly truncated: boolean;
    };

export type SessionReplacementAdmissionResult =
  | { readonly ok: true; readonly replacement: ValidatedSessionReplacement }
  | {
      readonly ok: false;
      readonly issues: readonly SessionValidationIssue[];
      readonly truncated: boolean;
    };

export function admitSessionObservation(candidate: unknown): SessionObservationAdmissionResult {
  const result = admitDiscoveredSession(candidate);
  return result.ok ? { ok: true, observation: result.admitted.observation } : result;
}

export function admitDiscoveredSession(candidate: unknown): DiscoveredSessionAdmissionResult {
  const collector: ObservationIssueCollector = { issues: [], truncated: false };
  const root = plainRecord(candidate);
  if (root === undefined || !hasExactKeys(root, CANDIDATE_KEYS)) {
    addObservationIssue(collector, "invalid-candidate", "/");
    return invalidObservation(collector);
  }

  const identity = snapshotIdentity(root.identity);
  if (identity === undefined) addObservationIssue(collector, "invalid-identity", "/identity");

  const inputs = snapshotInputs(root.inputs, collector);
  const aggregateFingerprint = snapshotAggregateFingerprint(root.aggregateFingerprint);
  if (aggregateFingerprint === undefined) {
    addObservationIssue(collector, "invalid-aggregate-fingerprint", "/aggregateFingerprint");
  }

  const adapterVersion = root.adapterVersion;
  if (!isNonEmptyWellFormedString(adapterVersion)) {
    addObservationIssue(collector, "invalid-adapter-version", "/adapterVersion");
  }

  if (inputs !== undefined && aggregateFingerprint !== undefined) {
    const expected = fingerprintSourceInputs(inputs);
    if (
      expected.scheme !== aggregateFingerprint.scheme ||
      expected.digest !== aggregateFingerprint.digest
    ) {
      addObservationIssue(collector, "invalid-inputs", "/inputs");
    }
  }

  if (
    collector.issues.length > 0 ||
    identity === undefined ||
    inputs === undefined ||
    aggregateFingerprint === undefined ||
    !isNonEmptyWellFormedString(adapterVersion)
  ) {
    return invalidObservation(collector);
  }

  const revision = Object.freeze({
    aggregateFingerprint: Object.freeze(aggregateFingerprint),
    adapterVersion,
  });
  const observation = Object.freeze({
    [observationBrand]: true as const,
    identity,
    revision,
  });
  const snapshot = Object.freeze({
    identity,
    inputs: Object.freeze(inputs),
    aggregateFingerprint: revision.aggregateFingerprint,
    adapterVersion,
  });
  return {
    ok: true,
    admitted: Object.freeze({
      [admittedCandidateBrand]: true as const,
      candidate: snapshot,
      observation,
    }),
  };
}

export function isAdmittedDiscoveredSession(value: unknown): value is AdmittedDiscoveredSession {
  if (typeof value !== "object" || value === null) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, admittedCandidateBrand);
    return descriptor !== undefined && "value" in descriptor && descriptor.value === true;
  } catch {
    return false;
  }
}

export function selectSessionSource(
  instance: SourceInstance,
  adapter: SessionSource,
): SelectedSessionSource {
  const snapshot = snapshotIdentity({ source: instance, nativeId: "selection" });
  if (snapshot === undefined) throw new TypeError("Invalid selected source instance");
  if (
    typeof adapter !== "object" ||
    adapter === null ||
    adapter.kind !== snapshot.source.kind ||
    typeof adapter.probe !== "function" ||
    typeof adapter.discover !== "function" ||
    typeof adapter.read !== "function"
  ) {
    throw new TypeError("Selected source adapter does not match its source instance");
  }

  return Object.freeze({
    instance: snapshot.source,
    adapter,
  });
}

const MAX_SESSION_OBSERVATION_ISSUES = 32;
const CANDIDATE_KEYS = new Set(["identity", "inputs", "aggregateFingerprint", "adapterVersion"]);
const IDENTITY_KEYS = new Set(["source", "nativeId"]);
const SOURCE_KEYS = new Set(["kind", "instanceId"]);
const INPUT_KEYS = new Set(["role", "locator", "fingerprint"]);
const LOCATOR_KEYS = new Set(["uri", "recordId"]);
const FINGERPRINT_KEYS = new Set(["scheme", "digest"]);

interface ObservationIssueCollector {
  readonly issues: SessionObservationIssue[];
  truncated: boolean;
}

function snapshotIdentity(value: unknown): SessionIdentity | undefined {
  const identity = plainRecord(value);
  if (identity === undefined || !hasExactKeys(identity, IDENTITY_KEYS)) return undefined;
  const source = plainRecord(identity.source);
  if (source === undefined || !hasExactKeys(source, SOURCE_KEYS)) return undefined;
  const snapshot = {
    source: { kind: source.kind, instanceId: source.instanceId },
    nativeId: identity.nativeId,
  };
  if (!isSessionIdentity(snapshot)) return undefined;
  return Object.freeze({
    source: Object.freeze({ ...snapshot.source }),
    nativeId: snapshot.nativeId,
  });
}

function snapshotInputs(
  value: unknown,
  collector: ObservationIssueCollector,
): readonly SourceInputDescriptor[] | undefined {
  const snapshot = snapshotArray(value);
  if (!snapshot.ok || snapshot.values.length === 0) {
    addObservationIssue(collector, "invalid-inputs", "/inputs");
    return undefined;
  }

  const inputs: SourceInputDescriptor[] = [];
  for (const [index, item] of snapshot.values.entries()) {
    const input = snapshotInput(item);
    if (input === undefined) {
      addObservationIssue(collector, "invalid-input", `/inputs/${index}`);
      continue;
    }
    inputs.push(input);
  }
  return inputs.length === snapshot.values.length ? inputs : undefined;
}

function snapshotInput(value: unknown): SourceInputDescriptor | undefined {
  const input = plainRecord(value);
  if (input === undefined || !hasExactKeys(input, INPUT_KEYS)) return undefined;
  const locator = plainRecord(input.locator);
  if (locator === undefined || !hasAllowedKeys(locator, LOCATOR_KEYS, ["uri"])) return undefined;
  if (
    !isNonEmptyWellFormedString(input.role) ||
    !isNonEmptyWellFormedString(input.fingerprint) ||
    !isNonEmptyWellFormedString(locator.uri)
  ) {
    return undefined;
  }
  let recordId: string | undefined;
  if (Object.hasOwn(locator, "recordId")) {
    if (!isNonEmptyWellFormedString(locator.recordId)) return undefined;
    recordId = locator.recordId;
  }

  return Object.freeze({
    role: input.role,
    locator: Object.freeze({
      uri: locator.uri,
      ...(recordId === undefined ? {} : { recordId }),
    }),
    fingerprint: input.fingerprint,
  });
}

function snapshotAggregateFingerprint(value: unknown): SourceInputAggregateFingerprint | undefined {
  const fingerprint = plainRecord(value);
  if (fingerprint === undefined || !hasExactKeys(fingerprint, FINGERPRINT_KEYS)) return undefined;
  if (
    fingerprint.scheme !== "sha256-json-v1" ||
    typeof fingerprint.digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(fingerprint.digest)
  ) {
    return undefined;
  }
  return { scheme: fingerprint.scheme, digest: fingerprint.digest };
}

function plainRecord(value: unknown): UnknownRecord | undefined {
  const snapshot = snapshotPlainRecord(value);
  return snapshot.ok ? snapshot.record : undefined;
}

function hasExactKeys(record: UnknownRecord, expected: ReadonlySet<string>): boolean {
  const keys = Reflect.ownKeys(record);
  return (
    keys.length === expected.size &&
    keys.every((key) => typeof key === "string" && expected.has(key))
  );
}

function hasAllowedKeys(
  record: UnknownRecord,
  allowed: ReadonlySet<string>,
  required: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(record);
  return (
    required.every((key) => Object.hasOwn(record, key)) &&
    keys.every((key) => typeof key === "string" && allowed.has(key))
  );
}

function isNonEmptyWellFormedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.isWellFormed();
}

function addObservationIssue(
  collector: ObservationIssueCollector,
  code: SessionObservationIssueCode,
  path: string,
): void {
  if (collector.issues.length < MAX_SESSION_OBSERVATION_ISSUES) {
    collector.issues.push({ code, path });
  } else {
    collector.truncated = true;
  }
}

function invalidObservation(
  collector: ObservationIssueCollector,
): Extract<SessionObservationAdmissionResult, { readonly ok: false }> {
  return { ok: false, issues: collector.issues, truncated: collector.truncated };
}

export function admitSessionReplacement(
  observation: SessionObservation,
  value: unknown,
): SessionReplacementAdmissionResult {
  if (observation[observationBrand] !== true) {
    throw new TypeError("Session observation was not admitted");
  }
  const result = validateSessionDocument(value, { expectedIdentity: observation.identity });
  if (!result.ok) return result;

  const document = freezeDocument(result.document);
  const publicDocument = projectPublicSessionDocument(document);
  const documentDigest = digestPublicSessionDocument(publicDocument);
  return {
    ok: true,
    replacement: Object.freeze({
      [replacementBrand]: true as const,
      observation,
      document,
      documentDigest,
    }),
  };
}

function freezeDocument(document: SessionDocument): SessionDocument {
  const identity = Object.freeze({
    source: Object.freeze({ ...document.identity.source }),
    nativeId: document.identity.nativeId,
  });
  const relations = Object.freeze(
    document.relations.map((relation) =>
      Object.freeze({
        kind: relation.kind,
        target: Object.freeze({
          source: Object.freeze({ ...relation.target.source }),
          nativeId: relation.target.nativeId,
        }),
        confidence: relation.confidence,
      }),
    ),
  );
  const entries = Object.freeze(
    document.entries.map((entry) =>
      Object.freeze({
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
        sourceLocator: Object.freeze({ ...entry.sourceLocator }),
        content: Object.freeze(
          entry.content.map((segment) =>
            segment.kind === "text"
              ? Object.freeze({
                  kind: segment.kind,
                  ordinal: segment.ordinal,
                  text: segment.text,
                  contentHash: Object.freeze({ ...segment.contentHash }),
                  origin: segment.origin,
                  originConfidence: segment.originConfidence,
                  sourceMetadata: Object.freeze({ ...segment.sourceMetadata }),
                })
              : Object.freeze({
                  kind: segment.kind,
                  ordinal: segment.ordinal,
                  contentClass: segment.contentClass,
                  sourceType: segment.sourceType,
                  origin: segment.origin,
                  originConfidence: segment.originConfidence,
                  sourceMetadata: Object.freeze({ ...segment.sourceMetadata }),
                }),
          ),
        ),
      }),
    ),
  );

  return Object.freeze({
    identity,
    ...(document.title === undefined ? {} : { title: document.title }),
    ...(document.workspace === undefined ? {} : { workspace: document.workspace }),
    ...(document.createdAt === undefined ? {} : { createdAt: document.createdAt }),
    ...(document.updatedAt === undefined ? {} : { updatedAt: document.updatedAt }),
    lineageCoverage: document.lineageCoverage,
    relations,
    entries,
  });
}
