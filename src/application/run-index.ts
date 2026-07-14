import { compareBinaryStrings, discoverSessions } from "./discover-sessions.ts";
import {
  createIndexReport,
  createIndexSourceReport,
  type IndexReport,
  type IndexSourceReport,
} from "./index-report.ts";
import type { IndexLifecycle, IndexPaths } from "./ports/index-lifecycle.ts";
import type {
  IndexRunFailureCode,
  SessionFreshness,
  SessionIndexWriter,
} from "./ports/session-index.ts";
import type {
  SelectedSessionSource,
  SourceProbe,
  SourceProbeStatus,
} from "./ports/session-source.ts";
import { readSessionReplacement } from "./read-session-document.ts";
import { isSourceFailureError } from "./source-failure.ts";
import {
  selectSessionSource,
  type SessionRevision,
  type ValidatedSessionReplacement,
} from "./validate-session.ts";
import { snapshotArray, snapshotPlainRecord } from "../domain/data-snapshot.ts";
import { isSessionIdentity } from "../domain/session-identity.ts";
import type { SessionIdentity, SourceInstance } from "../domain/session.ts";

export interface IndexClock {
  now(): Date;
}

export interface RunIndexInput {
  readonly paths: IndexPaths;
  readonly sources: readonly SelectedSessionSource[];
  readonly lifecycle: IndexLifecycle;
  readonly clock: IndexClock;
}

export async function runIndex(input: RunIndexInput): Promise<IndexReport> {
  // Selection errors must never create or open the index.
  const selections = prepareSelections(input.sources);
  const startedAt = timestamp(input.clock);
  let writer: Awaited<ReturnType<IndexLifecycle["openWriter"]>> | undefined;
  let report: IndexReport | undefined;
  let operationError: unknown;
  let operationFailed = false;

  try {
    writer = await input.lifecycle.openWriter(input.paths);
    const sourceReports: IndexSourceReport[] = [];
    for (const selection of selections) {
      sourceReports.push(await runSource(writer.sessions, selection, input.clock));
    }
    report = createIndexReport(startedAt, timestamp(input.clock), sourceReports);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  let closeError: unknown;
  let closeFailed = false;
  if (writer !== undefined) {
    try {
      await writer.close();
    } catch (error) {
      closeFailed = true;
      closeError = error;
    }
  }

  if (operationFailed && closeFailed) {
    throw new AggregateError(
      [operationError, closeError],
      "Session indexing and writer close both failed",
      { cause: operationError },
    );
  }
  if (operationFailed) throw operationError;
  if (closeFailed) throw closeError;
  if (report === undefined) throw new Error("Session indexing produced no report");
  return report;
}

async function runSource(
  index: SessionIndexWriter,
  selection: SelectedSessionSource,
  clock: IndexClock,
): Promise<IndexSourceReport> {
  const run = await index.startRun({
    source: selection.instance,
    startedAt: timestamp(clock),
  });
  let finishAttempted = false;

  const finish = async (
    status: "completed" | "incomplete",
    failure?: IndexRunFailureCode,
  ): Promise<IndexSourceReport> => {
    finishAttempted = true;
    const finishedAt = timestamp(clock);
    const result =
      status === "completed"
        ? await index.finishRun(run, { status, finishedAt })
        : await index.finishRun(run, {
            status,
            finishedAt,
            failure: requireFailure(failure),
          });
    assertRunResultSource(result.source, selection.instance);
    return createIndexSourceReport(selection.instance, result);
  };

  try {
    const probeFailure = await probe(selection);
    if (probeFailure !== undefined) return await finish("incomplete", probeFailure);

    const discovery = await discoverSessions(selection);
    if (!discovery.complete) return await finish("incomplete", "discovery-failed");

    const seen = new Set<string>();
    for (const candidate of discovery.candidates) {
      const observation = candidate.observation;
      seen.add(observation.identity.nativeId);
      const freshness = await index.getFreshness(observation.identity);
      if (matchesLastGoodRevision(freshness, observation.revision)) {
        await index.recordUnchanged(run, observation);
        continue;
      }

      let replacement: ValidatedSessionReplacement;
      try {
        replacement = await readSessionReplacement(selection.adapter, candidate);
      } catch (error) {
        if (!isSourceFailureError(error)) throw error;
        await index.recordFailure(run, observation, error.failure.kind);
        continue;
      }
      // Repository replacement failures are already durably recorded once by the port.
      await index.replaceSession(run, replacement);
    }

    const indexed = await index.listIndexedIdentities(selection.instance);
    const ordered = validateIndexedIdentities(indexed, selection.instance);
    for (const identity of ordered) {
      if (!seen.has(identity.nativeId)) await index.removeSession(run, identity);
    }
    return await finish("completed");
  } catch (operationError) {
    if (finishAttempted) throw operationError;
    try {
      await finish("incomplete", "repository-write");
    } catch (finalizationError) {
      throw new AggregateError(
        [operationError, finalizationError],
        "Session indexing operation and run finalization both failed",
        { cause: operationError },
      );
    }
    throw operationError;
  }
}

function prepareSelections(
  selections: readonly SelectedSessionSource[],
): readonly SelectedSessionSource[] {
  if (selections.length === 0) throw new TypeError("At least one session source must be selected");
  const admitted = selections.map(({ instance, adapter }) =>
    selectSessionSource(instance, adapter),
  );
  for (const [index, selection] of admitted.entries()) {
    if (
      admitted.some(
        (other, otherIndex) => otherIndex < index && sameSource(other.instance, selection.instance),
      )
    ) {
      throw new TypeError("Duplicate selected source instance");
    }
  }
  return Object.freeze(
    admitted.sort(
      (left, right) =>
        compareBinaryStrings(left.instance.kind, right.instance.kind) ||
        compareBinaryStrings(left.instance.instanceId, right.instance.instanceId),
    ),
  );
}

async function probe(selection: SelectedSessionSource): Promise<IndexRunFailureCode | undefined> {
  let value: unknown;
  try {
    value = await selection.adapter.probe();
  } catch (error) {
    if (isSourceFailureError(error) && sameSource(error.failure.source, selection.instance)) {
      if (error.failure.kind === "unavailable") return "source-unavailable";
      if (error.failure.kind === "unreadable") return "source-unreadable";
    }
    return "probe-failed";
  }

  const admitted = admitProbe(value);
  if (admitted === undefined || !sameSource(admitted.source, selection.instance)) {
    return "probe-failed";
  }
  return probeStatusFailure(admitted.status);
}

function admitProbe(value: unknown): SourceProbe | undefined {
  const root = snapshotPlainRecord(value);
  if (!root.ok || !hasExactKeys(root.record, ["source", "status", "locations", "summary"])) {
    return undefined;
  }
  const source = snapshotPlainRecord(root.record.source);
  if (
    !source.ok ||
    !hasExactKeys(source.record, ["kind", "instanceId"]) ||
    !isSessionIdentity({ source: source.record, nativeId: "probe" })
  ) {
    return undefined;
  }
  const status = root.record.status;
  if (status !== "ready" && status !== "unavailable" && status !== "unreadable") {
    return undefined;
  }
  if (!isNonEmptyWellFormedString(root.record.summary)) return undefined;

  const locations = snapshotArray(root.record.locations);
  if (!locations.ok || locations.values.length === 0) return undefined;
  const admittedLocations = [];
  for (const value of locations.values) {
    const location = snapshotPlainRecord(value);
    if (!location.ok || !hasExactKeys(location.record, ["role", "locator"])) return undefined;
    const locator = snapshotPlainRecord(location.record.locator);
    if (
      !locator.ok ||
      !hasAllowedKeys(locator.record, ["uri", "recordId"], ["uri"]) ||
      !isNonEmptyWellFormedString(location.record.role) ||
      !isNonEmptyWellFormedString(locator.record.uri) ||
      (Object.hasOwn(locator.record, "recordId") &&
        !isNonEmptyWellFormedString(locator.record.recordId))
    ) {
      return undefined;
    }
    admittedLocations.push({
      role: location.record.role,
      locator: {
        uri: locator.record.uri,
        ...(Object.hasOwn(locator.record, "recordId")
          ? { recordId: locator.record.recordId as string }
          : {}),
      },
    });
  }

  return {
    source: { kind: source.record.kind, instanceId: source.record.instanceId },
    status,
    locations: admittedLocations,
    summary: root.record.summary,
  } as SourceProbe;
}

function matchesLastGoodRevision(freshness: SessionFreshness, revision: SessionRevision): boolean {
  if (freshness.status !== "current" && freshness.status !== "stale") return false;
  return (
    freshness.lastGood.adapterVersion === revision.adapterVersion &&
    freshness.lastGood.aggregateFingerprint.scheme === revision.aggregateFingerprint.scheme &&
    freshness.lastGood.aggregateFingerprint.digest === revision.aggregateFingerprint.digest
  );
}

function validateIndexedIdentities(
  identities: readonly SessionIdentity[],
  source: SourceInstance,
): readonly SessionIdentity[] {
  const nativeIds = new Set<string>();
  const result: SessionIdentity[] = [];
  for (const identity of identities) {
    if (!isSessionIdentity(identity) || !sameSource(identity.source, source)) {
      throw new TypeError("Session repository returned an invalid indexed identity");
    }
    if (nativeIds.has(identity.nativeId)) {
      throw new TypeError("Session repository returned a duplicate indexed identity");
    }
    nativeIds.add(identity.nativeId);
    result.push({ source: { ...source }, nativeId: identity.nativeId });
  }
  return result.sort((left, right) => compareBinaryStrings(left.nativeId, right.nativeId));
}

function assertRunResultSource(actual: SourceInstance, selected: SourceInstance): void {
  if (!sameSource(actual, selected)) {
    throw new TypeError("Session repository returned a run result for another source");
  }
}

function probeStatusFailure(status: SourceProbeStatus): IndexRunFailureCode | undefined {
  if (status === "unavailable") return "source-unavailable";
  if (status === "unreadable") return "source-unreadable";
  return undefined;
}

function requireFailure(failure: IndexRunFailureCode | undefined): IndexRunFailureCode {
  if (failure === undefined) throw new TypeError("Incomplete index run requires a failure code");
  return failure;
}

function timestamp(clock: IndexClock): string {
  return clock.now().toISOString();
}

function sameSource(left: SourceInstance, right: SourceInstance): boolean {
  return left.kind === right.kind && left.instanceId === right.instanceId;
}

function hasExactKeys(
  record: Readonly<Record<PropertyKey, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(record);
  return keys.length === expected.length && keys.every((key) => expected.includes(String(key)));
}

function hasAllowedKeys(
  record: Readonly<Record<PropertyKey, unknown>>,
  allowed: readonly string[],
  required: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(record);
  return (
    required.every((key) => Object.hasOwn(record, key)) &&
    keys.every((key) => typeof key === "string" && allowed.includes(key))
  );
}

function isNonEmptyWellFormedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.isWellFormed();
}
