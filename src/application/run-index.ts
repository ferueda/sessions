import { compareBinaryStrings, discoverSessions } from "./discover-sessions.ts";
import { admitSourceProbe } from "./admit-source-probe.ts";
import { isIndexInterruptedError, throwIfIndexInterrupted } from "./index-interruption.ts";
import type { IndexProgressObserver } from "./index-progress.ts";
import { timeIndexOperation, type IndexTimingRecorder } from "./index-timing.ts";
import { mapLibraryBusyError } from "./library-error.ts";
import {
  createIndexReport,
  createIndexSourceReport,
  createSkippedIndexSourceReport,
  type IndexReport,
  type IndexSourceReport,
} from "./index-report.ts";
import type { IndexLifecycle, IndexPaths } from "./ports/index-lifecycle.ts";
import type {
  IndexRunFailureCode,
  RecordableSessionFailureCode,
  SessionFreshness,
  SessionIndexRun,
  SessionIndexWriter,
} from "./ports/session-index.ts";
import type {
  SelectedSessionSource,
  SourceCaptureWorkspace,
  SourceProbeStatus,
} from "./ports/session-source.ts";
import { readSessionReplacement } from "./read-session-document.ts";
import { isSourceFailureError } from "./source-failure.ts";
import {
  selectSessionSource,
  type AdmittedDiscoveredSession,
  type SessionRevision,
  type ValidatedSessionReplacement,
} from "./validate-session.ts";
import { isSessionIdentity } from "../domain/session-identity.ts";
import type { SessionIdentity, SourceInstance } from "../domain/session.ts";

export interface IndexClock {
  now(): Date;
}

export interface RunIndexInput {
  readonly paths: IndexPaths;
  readonly sources: readonly SelectedSessionSource[];
  readonly sourceSelection?: "required" | "optional";
  readonly lifecycle: IndexLifecycle;
  readonly clock: IndexClock;
  readonly progress?: IndexProgressObserver;
  readonly signal?: AbortSignal;
  readonly timing?: IndexTimingRecorder;
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
    throwIfIndexInterrupted(input.signal);
    const skipped = await preflightOptionalSources(
      selections,
      input.sourceSelection ?? "required",
      input.clock,
      input.signal,
      input.timing,
    );
    throwIfIndexInterrupted(input.signal);
    const sourceReports: IndexSourceReport[] = [];
    const attempted = selections.filter((selection) => !skipped.has(selection));
    if (attempted.length > 0) {
      writer = await timeIndexOperation(input.timing, "writerOpen", () =>
        input.lifecycle.openWriter(input.paths, {
          ...(input.progress === undefined ? {} : { progress: input.progress }),
          ...(input.timing === undefined ? {} : { timing: input.timing }),
        }),
      );
      throwIfIndexInterrupted(input.signal);
    }
    for (const selection of selections) {
      throwIfIndexInterrupted(input.signal);
      const skippedReport = skipped.get(selection);
      if (skippedReport !== undefined) {
        sourceReports.push(skippedReport);
      } else {
        if (writer === undefined) throw new Error("Attempted indexing requires a writer");
        sourceReports.push(
          await runSource(
            writer.sessions,
            writer.workspace,
            selection,
            input.clock,
            input.timing,
            input.signal,
          ),
        );
        throwIfIndexInterrupted(input.signal);
      }
    }
    report = createIndexReport(startedAt, timestamp(input.clock), sourceReports);
  } catch (error) {
    operationFailed = true;
    operationError = mapLibraryBusyError(error);
  }

  let closeError: unknown;
  let closeFailed = false;
  if (writer !== undefined) {
    try {
      await timeIndexOperation(input.timing, "writerClose", () => writer.close());
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
  throwIfIndexInterrupted(input.signal);
  if (report === undefined) throw new Error("Session indexing produced no report");
  return report;
}

async function preflightOptionalSources(
  selections: readonly SelectedSessionSource[],
  mode: "required" | "optional",
  clock: IndexClock,
  signal: AbortSignal | undefined,
  timing: IndexTimingRecorder | undefined,
): Promise<ReadonlyMap<SelectedSessionSource, IndexSourceReport>> {
  const skipped = new Map<SelectedSessionSource, IndexSourceReport>();
  if (mode === "required") return skipped;

  for (const selection of selections) {
    throwIfIndexInterrupted(signal);
    const startedAt = timestamp(clock);
    const unavailable = await timeIndexOperation(timing, "sourceProbe", () =>
      isValidUnavailableSource(selection),
    );
    throwIfIndexInterrupted(signal);
    if (unavailable) {
      skipped.set(
        selection,
        createSkippedIndexSourceReport(selection.instance, startedAt, timestamp(clock)),
      );
    }
  }
  return skipped;
}

async function isValidUnavailableSource(selection: SelectedSessionSource): Promise<boolean> {
  let value: unknown;
  try {
    value = await selection.adapter.probe();
  } catch {
    return false;
  }
  const admitted = admitSourceProbe(value);
  return (
    admitted !== undefined &&
    sameSource(admitted.source, selection.instance) &&
    admitted.status === "unavailable"
  );
}

async function runSource(
  index: SessionIndexWriter,
  workspace: SourceCaptureWorkspace,
  selection: SelectedSessionSource,
  clock: IndexClock,
  timing: IndexTimingRecorder | undefined,
  signal?: AbortSignal,
): Promise<IndexSourceReport> {
  throwIfIndexInterrupted(signal);
  const run = await timeIndexOperation(timing, "runBookkeeping", () =>
    index.startRun({
      source: selection.instance,
      startedAt: timestamp(clock),
    }),
  );
  let finishAttempted = false;

  const finish = async (
    status: "completed" | "incomplete",
    failure?: IndexRunFailureCode,
  ): Promise<IndexSourceReport> => {
    throwIfIndexInterrupted(signal);
    finishAttempted = true;
    const finishedAt = timestamp(clock);
    const result = await timeIndexOperation(timing, "runBookkeeping", () =>
      status === "completed"
        ? index.finishRun(run, { status, finishedAt })
        : index.finishRun(run, {
            status,
            finishedAt,
            failure: requireFailure(failure),
          }),
    );
    throwIfIndexInterrupted(signal);
    assertRunResultSource(result.source, selection.instance);
    return createIndexSourceReport(selection.instance, result);
  };

  try {
    throwIfIndexInterrupted(signal);
    const probeFailure = await timeIndexOperation(timing, "sourceProbe", () => probe(selection));
    throwIfIndexInterrupted(signal);
    if (probeFailure !== undefined) return await finish("incomplete", probeFailure);

    const discovery = await timeIndexOperation(timing, "sourceDiscovery", () =>
      discoverSessions(selection, workspace, signal),
    );
    throwIfIndexInterrupted(signal);
    if (!discovery.complete) return await finish("incomplete", "discovery-failed");

    const seen = new Set<string>();
    const deferred: AdmittedDiscoveredSession[] = [];
    for (const candidate of discovery.candidates) {
      throwIfIndexInterrupted(signal);
      const observation = candidate.observation;
      seen.add(observation.identity.nativeId);
      const failure = await applyCandidate(
        index,
        run,
        selection,
        candidate,
        workspace,
        timing,
        signal,
      );
      throwIfIndexInterrupted(signal);
      if (failure === "source-changed") {
        deferred.push(candidate);
      } else if (failure !== undefined) {
        throwIfIndexInterrupted(signal);
        await timeIndexOperation(timing, "runBookkeeping", () =>
          index.recordFailure(run, observation, failure),
        );
      }
    }

    if (deferred.length > 0) {
      await retrySourceChanged(index, run, selection, workspace, deferred, timing, signal);
      throwIfIndexInterrupted(signal);
    }

    throwIfIndexInterrupted(signal);
    const tracked = await timeIndexOperation(timing, "reconciliation", () =>
      index.listTrackedIdentities(selection.instance),
    );
    throwIfIndexInterrupted(signal);
    const ordered = validateTrackedIdentities(tracked, selection.instance);
    for (const identity of ordered) {
      throwIfIndexInterrupted(signal);
      if (!seen.has(identity.nativeId)) {
        await timeIndexOperation(timing, "reconciliation", () =>
          index.recordMissing(run, identity),
        );
      }
    }
    throwIfIndexInterrupted(signal);
    return await finish("completed");
  } catch (operationError) {
    if (isIndexInterruptedError(operationError)) throw operationError;
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

async function applyCandidate(
  index: SessionIndexWriter,
  run: SessionIndexRun,
  selection: SelectedSessionSource,
  candidate: AdmittedDiscoveredSession,
  workspace: SourceCaptureWorkspace,
  timing: IndexTimingRecorder | undefined,
  signal: AbortSignal | undefined,
): Promise<RecordableSessionFailureCode | undefined> {
  throwIfIndexInterrupted(signal);
  const observation = candidate.observation;
  const freshness = await timeIndexOperation(timing, "freshnessRead", () =>
    index.getFreshness(observation.identity),
  );
  throwIfIndexInterrupted(signal);
  if (matchesLastGoodRevision(freshness, observation.revision)) {
    await timeIndexOperation(timing, "unchangedWrite", () =>
      index.recordUnchanged(run, observation),
    );
    return undefined;
  }
  if (!allowsReplacement(selection, freshness, observation.revision)) {
    return "unsupported-format";
  }

  let replacement: ValidatedSessionReplacement;
  try {
    replacement = await timeIndexOperation(timing, "changedReadAndNormalize", () =>
      readSessionReplacement(selection.adapter, candidate, workspace),
    );
  } catch (error) {
    if (!isSourceFailureError(error)) throw error;
    return error.failure.kind;
  }
  throwIfIndexInterrupted(signal);
  // Repository replacement failures are already durably recorded once by the port.
  await timeIndexOperation(timing, "replacement", () => index.replaceSession(run, replacement));
  return undefined;
}

function allowsReplacement(
  selection: SelectedSessionSource,
  freshness: SessionFreshness,
  revision: SessionRevision,
): boolean {
  if (freshness.status !== "current" && freshness.status !== "stale") return true;
  try {
    const guard = selection.adapter.canReplace;
    if (guard === undefined) return true;
    if (typeof guard !== "function") return false;
    const allowed: unknown = guard.call(
      selection.adapter,
      freshness.lastGood.adapterVersion,
      revision.adapterVersion,
    );
    return allowed === true;
  } catch {
    return false;
  }
}

async function retrySourceChanged(
  index: SessionIndexWriter,
  run: SessionIndexRun,
  selection: SelectedSessionSource,
  workspace: SourceCaptureWorkspace,
  deferred: readonly AdmittedDiscoveredSession[],
  timing: IndexTimingRecorder | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfIndexInterrupted(signal);
  const discovery = await timeIndexOperation(timing, "sourceDiscovery", () =>
    discoverSessions(selection, workspace, signal),
  );
  throwIfIndexInterrupted(signal);
  if (!discovery.complete) {
    for (const candidate of deferred) {
      throwIfIndexInterrupted(signal);
      await timeIndexOperation(timing, "runBookkeeping", () =>
        index.recordFailure(run, candidate.observation, "source-changed"),
      );
    }
    return;
  }

  const freshByNativeId = new Map(
    discovery.candidates.map((candidate) => [candidate.observation.identity.nativeId, candidate]),
  );
  for (const candidate of deferred) {
    throwIfIndexInterrupted(signal);
    const fresh = freshByNativeId.get(candidate.observation.identity.nativeId);
    if (fresh === undefined) {
      await timeIndexOperation(timing, "runBookkeeping", () =>
        index.recordFailure(run, candidate.observation, "source-changed"),
      );
      continue;
    }

    const failure = await applyCandidate(index, run, selection, fresh, workspace, timing, signal);
    throwIfIndexInterrupted(signal);
    if (failure !== undefined) {
      await timeIndexOperation(timing, "runBookkeeping", () =>
        index.recordFailure(run, fresh.observation, failure),
      );
    }
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

  const admitted = admitSourceProbe(value);
  if (admitted === undefined || !sameSource(admitted.source, selection.instance)) {
    return "probe-failed";
  }
  return probeStatusFailure(admitted.status);
}

function matchesLastGoodRevision(freshness: SessionFreshness, revision: SessionRevision): boolean {
  if (freshness.status !== "current" && freshness.status !== "stale") return false;
  return (
    freshness.lastGood.adapterVersion === revision.adapterVersion &&
    freshness.lastGood.aggregateFingerprint.scheme === revision.aggregateFingerprint.scheme &&
    freshness.lastGood.aggregateFingerprint.digest === revision.aggregateFingerprint.digest
  );
}

function validateTrackedIdentities(
  identities: readonly SessionIdentity[],
  source: SourceInstance,
): readonly SessionIdentity[] {
  const nativeIds = new Set<string>();
  const result: SessionIdentity[] = [];
  for (const identity of identities) {
    if (!isSessionIdentity(identity) || !sameSource(identity.source, source)) {
      throw new TypeError("Session repository returned an invalid tracked identity");
    }
    if (nativeIds.has(identity.nativeId)) {
      throw new TypeError("Session repository returned a duplicate tracked identity");
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
