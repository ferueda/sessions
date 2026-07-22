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
  TrackedIdentityPage,
} from "./ports/session-index.ts";
import { SESSION_INDEX_BATCH_LIMIT } from "./ports/session-index.ts";
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
  type SessionObservation,
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

    const deferred: AdmittedDiscoveredSession[] = [];
    await processCandidateBatches(
      index,
      run,
      selection,
      discovery.candidates,
      workspace,
      timing,
      signal,
      async (candidate, failure) => {
        if (failure === "source-changed") {
          deferred.push(candidate);
          return;
        }
        throwIfIndexInterrupted(signal);
        await timeIndexOperation(timing, "runBookkeeping", () =>
          index.recordFailure(run, candidate.observation, failure),
        );
      },
    );

    if (deferred.length > 0) {
      await retrySourceChanged(index, run, selection, workspace, deferred, timing, signal);
      throwIfIndexInterrupted(signal);
    }

    await reconcileMissing(index, run, selection.instance, discovery.candidates, timing, signal);
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

type CandidateFailureHandler = (
  candidate: AdmittedDiscoveredSession,
  failure: RecordableSessionFailureCode,
) => Promise<void>;

async function processCandidateBatches(
  index: SessionIndexWriter,
  run: SessionIndexRun,
  selection: SelectedSessionSource,
  candidates: readonly AdmittedDiscoveredSession[],
  workspace: SourceCaptureWorkspace,
  timing: IndexTimingRecorder | undefined,
  signal: AbortSignal | undefined,
  onFailure: CandidateFailureHandler,
): Promise<void> {
  for (let start = 0; start < candidates.length; start += SESSION_INDEX_BATCH_LIMIT) {
    throwIfIndexInterrupted(signal);
    const batch = candidates.slice(start, start + SESSION_INDEX_BATCH_LIMIT);
    const identities = batch.map(({ observation }) => observation.identity);
    const rawFreshness = await timeIndexOperation(timing, "freshnessRead", () =>
      index.getFreshnessBatch(run, identities),
    );
    throwIfIndexInterrupted(signal);
    const freshness = validateFreshnessBatch(rawFreshness, identities);
    let unchanged: SessionObservation[] = [];

    const flushUnchanged = async (): Promise<void> => {
      if (unchanged.length === 0) return;
      throwIfIndexInterrupted(signal);
      const observations = unchanged;
      unchanged = [];
      await timeIndexOperation(timing, "unchangedWrite", () =>
        index.recordUnchangedBatch(run, observations),
      );
      throwIfIndexInterrupted(signal);
    };

    for (const [offset, candidate] of batch.entries()) {
      throwIfIndexInterrupted(signal);
      const candidateFreshness = freshness[offset];
      if (candidateFreshness === undefined) {
        throw new TypeError("Session repository returned incomplete freshness results");
      }
      const observation = candidate.observation;
      if (matchesLastGoodRevision(candidateFreshness, observation.revision)) {
        unchanged.push(observation);
        continue;
      }

      await flushUnchanged();
      const failure = await applyChangedCandidate(
        index,
        run,
        selection,
        candidate,
        candidateFreshness,
        workspace,
        timing,
        signal,
      );
      throwIfIndexInterrupted(signal);
      if (failure !== undefined) await onFailure(candidate, failure);
      throwIfIndexInterrupted(signal);
    }

    await flushUnchanged();
  }
}

async function applyChangedCandidate(
  index: SessionIndexWriter,
  run: SessionIndexRun,
  selection: SelectedSessionSource,
  candidate: AdmittedDiscoveredSession,
  freshness: SessionFreshness,
  workspace: SourceCaptureWorkspace,
  timing: IndexTimingRecorder | undefined,
  signal: AbortSignal | undefined,
): Promise<RecordableSessionFailureCode | undefined> {
  const observation = candidate.observation;
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
  let pending: AdmittedDiscoveredSession[] = [];

  const flushPending = async (): Promise<void> => {
    if (pending.length === 0) return;
    const candidates = pending;
    pending = [];
    await processCandidateBatches(
      index,
      run,
      selection,
      candidates,
      workspace,
      timing,
      signal,
      async (candidate, failure) => {
        throwIfIndexInterrupted(signal);
        await timeIndexOperation(timing, "runBookkeeping", () =>
          index.recordFailure(run, candidate.observation, failure),
        );
      },
    );
  };

  for (const candidate of deferred) {
    throwIfIndexInterrupted(signal);
    const fresh = freshByNativeId.get(candidate.observation.identity.nativeId);
    if (fresh === undefined) {
      await flushPending();
      throwIfIndexInterrupted(signal);
      await timeIndexOperation(timing, "runBookkeeping", () =>
        index.recordFailure(run, candidate.observation, "source-changed"),
      );
      continue;
    }
    pending.push(fresh);
    if (pending.length === SESSION_INDEX_BATCH_LIMIT) {
      await flushPending();
    }
  }
  await flushPending();
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

async function reconcileMissing(
  index: SessionIndexWriter,
  run: SessionIndexRun,
  source: SourceInstance,
  primaryCandidates: readonly AdmittedDiscoveredSession[],
  timing: IndexTimingRecorder | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  let candidateIndex = 0;
  let afterNativeId: string | undefined;

  while (true) {
    throwIfIndexInterrupted(signal);
    const rawPage = await timeIndexOperation(timing, "reconciliation", () =>
      index.listTrackedIdentitiesPage(run, afterNativeId),
    );
    throwIfIndexInterrupted(signal);
    const page = validateTrackedIdentityPage(rawPage, source, afterNativeId);
    if (afterNativeId !== undefined && page.identities.length === 0) {
      throw new TypeError("Session repository returned a non-advancing tracked identity page");
    }

    const missing: SessionIdentity[] = [];
    for (const identity of page.identities) {
      let candidate = primaryCandidates[candidateIndex];
      while (
        candidate !== undefined &&
        compareBinaryStrings(candidate.observation.identity.nativeId, identity.nativeId) < 0
      ) {
        candidateIndex += 1;
        candidate = primaryCandidates[candidateIndex];
      }
      if (
        candidate === undefined ||
        compareBinaryStrings(candidate.observation.identity.nativeId, identity.nativeId) !== 0
      ) {
        missing.push(identity);
      } else {
        candidateIndex += 1;
      }
    }

    if (missing.length > 0) {
      throwIfIndexInterrupted(signal);
      await timeIndexOperation(timing, "reconciliation", () =>
        index.recordMissingBatch(run, missing),
      );
      throwIfIndexInterrupted(signal);
    }

    if (!page.hasMore) return;
    const last = page.identities.at(-1);
    if (last === undefined) {
      throw new TypeError("Session repository returned an invalid tracked identity page");
    }
    afterNativeId = last.nativeId;
  }
}

function validateFreshnessBatch(
  value: readonly SessionFreshness[],
  identities: readonly SessionIdentity[],
): readonly SessionFreshness[] {
  if (!Array.isArray(value) || value.length !== identities.length) {
    throw new TypeError("Session repository returned inconsistent freshness results");
  }
  for (const [index, expected] of identities.entries()) {
    const freshness: unknown = value[index];
    if (
      typeof freshness !== "object" ||
      freshness === null ||
      !("identity" in freshness) ||
      !isSessionIdentity(freshness.identity) ||
      !sameIdentity(freshness.identity, expected)
    ) {
      throw new TypeError("Session repository returned inconsistent freshness results");
    }
  }
  return value;
}

function validateTrackedIdentityPage(
  value: TrackedIdentityPage,
  source: SourceInstance,
  afterNativeId: string | undefined,
): TrackedIdentityPage {
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray(value.identities) ||
    typeof value.hasMore !== "boolean" ||
    value.identities.length > SESSION_INDEX_BATCH_LIMIT ||
    (value.hasMore && value.identities.length !== SESSION_INDEX_BATCH_LIMIT)
  ) {
    throw new TypeError("Session repository returned an invalid tracked identity page");
  }

  const identities: SessionIdentity[] = [];
  let previousNativeId = afterNativeId;
  for (const identity of value.identities) {
    if (
      !isSessionIdentity(identity) ||
      !sameSource(identity.source, source) ||
      (previousNativeId !== undefined &&
        compareBinaryStrings(previousNativeId, identity.nativeId) >= 0)
    ) {
      throw new TypeError("Session repository returned an invalid tracked identity page");
    }
    identities.push({ source: { ...source }, nativeId: identity.nativeId });
    previousNativeId = identity.nativeId;
  }
  return Object.freeze({ identities: Object.freeze(identities), hasMore: value.hasMore });
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

function sameIdentity(left: SessionIdentity, right: SessionIdentity): boolean {
  return sameSource(left.source, right.source) && left.nativeId === right.nativeId;
}
