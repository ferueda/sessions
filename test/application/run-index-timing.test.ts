import { describe, expect, test } from "vitest";

import {
  INDEX_TIMING_PHASES,
  type IndexTimingPhase,
  type IndexTimingRecorder,
} from "../../src/application/index-timing.ts";
import type { IndexLifecycle } from "../../src/application/ports/index-lifecycle.ts";
import {
  createSessionIndexRunId,
  type FinishIndexRunInput,
  type IndexRunCounts,
  type IndexRunItem,
  type IndexRunResult,
  type SessionFreshness,
  type SessionIndexRun,
  type SessionIndexWriter,
} from "../../src/application/ports/session-index.ts";
import type {
  DiscoveredSession,
  SelectedSessionSource,
} from "../../src/application/ports/session-source.ts";
import { runIndex, type IndexClock } from "../../src/application/run-index.ts";
import type {
  SessionObservation,
  SessionRevision,
  ValidatedSessionReplacement,
} from "../../src/application/validate-session.ts";
import type { SessionIdentity, SourceInstance } from "../../src/domain/session.ts";
import { syntheticCaptureWorkspace } from "../fixtures/capture-workspace.ts";
import { createFakeIndexingSource } from "../fixtures/indexing-source.ts";

const paths = {
  directory: "/tmp/sessions-timing-test",
  scratch: "/tmp/sessions-timing-test/.scratch",
  database: "/tmp/sessions-timing-test/sessions.sqlite3",
  wal: "/tmp/sessions-timing-test/sessions.sqlite3-wal",
  shm: "/tmp/sessions-timing-test/sessions.sqlite3-shm",
};

describe("runIndex timing", () => {
  test("records the stable-session path without a provider read", async () => {
    const source = createFakeIndexingSource();
    const candidate = source.candidate("stable-session");
    source.setDiscovery([candidate]);
    const harness = createIndexHarness({
      freshness: (sessionIdentity) => currentFreshness(sessionIdentity, revision(candidate)),
    });
    const timing = createPhaseCounter();

    const report = await execute(source.selected, harness.lifecycle, timing.recorder);

    expect(report.counts).toEqual(indexCounts({ discovered: 1, unchanged: 1 }));
    expect(source.readNativeIds).toEqual([]);
    expect(timing.snapshot()).toEqual(phaseCalls({ freshnessRead: 1, unchangedWrite: 1 }));
  });

  test("records changed read and replacement as separate phases", async () => {
    const source = createFakeIndexingSource();
    source.setDiscovery([source.candidate("changed-session")]);
    const harness = createIndexHarness();
    const timing = createPhaseCounter();

    const report = await execute(source.selected, harness.lifecycle, timing.recorder);

    expect(report.counts).toEqual(indexCounts({ discovered: 1, updated: 1 }));
    expect(source.readNativeIds).toEqual(["changed-session"]);
    expect(timing.snapshot()).toEqual(
      phaseCalls({ freshnessRead: 1, changedReadAndNormalize: 1, replacement: 1 }),
    );
  });

  test("records both reads and the one fresh rediscovery after source change", async () => {
    const source = createFakeIndexingSource();
    const primary = source.candidate("retry-session", "primary-revision");
    const fresh = source.candidate("retry-session", "fresh-revision");
    source.queueDiscoveries({ candidates: [primary] }, { candidates: [fresh] });
    source.failNextRead("retry-session", "source-changed");
    const harness = createIndexHarness();
    const timing = createPhaseCounter();

    const report = await execute(source.selected, harness.lifecycle, timing.recorder);

    expect(report.counts).toEqual(indexCounts({ discovered: 1, updated: 1 }));
    expect(source.readNativeIds).toEqual(["retry-session", "retry-session"]);
    expect(source.discoveryWorkspaces).toHaveLength(2);
    expect(timing.snapshot()).toEqual(
      phaseCalls({
        sourceDiscovery: 2,
        freshnessRead: 2,
        changedReadAndNormalize: 2,
        replacement: 1,
      }),
    );
  });

  test("records tracked lookup and missing write as reconciliation", async () => {
    const source = createFakeIndexingSource();
    source.setDiscovery([]);
    const missing = identity(source.instance, "missing-session");
    const harness = createIndexHarness({ tracked: [missing] });
    const timing = createPhaseCounter();

    const report = await execute(source.selected, harness.lifecycle, timing.recorder);

    expect(report.counts).toEqual(indexCounts({ missing: 1 }));
    expect(report.sources[0]?.items).toMatchObject([
      { identity: { nativeId: "missing-session" }, outcome: "missing" },
    ]);
    expect(timing.snapshot()).toEqual(phaseCalls({ reconciliation: 2 }));
  });

  test("records writer close while preserving its original failure", async () => {
    const source = createFakeIndexingSource();
    source.setDiscovery([]);
    const closeError = new Error("original writer close failure");
    const harness = createIndexHarness({ closeError });
    const timing = createPhaseCounter();

    await expect(execute(source.selected, harness.lifecycle, timing.recorder)).rejects.toBe(
      closeError,
    );

    expect(timing.snapshot()).toEqual(phaseCalls());
  });
});

async function execute(
  source: SelectedSessionSource,
  lifecycle: IndexLifecycle,
  timing: IndexTimingRecorder,
) {
  return runIndex({ paths, sources: [source], lifecycle, clock: clock(), timing });
}

interface IndexHarnessOptions {
  readonly freshness?: (identity: SessionIdentity) => SessionFreshness;
  readonly tracked?: readonly SessionIdentity[];
  readonly closeError?: unknown;
}

function createIndexHarness(options: IndexHarnessOptions = {}): {
  readonly lifecycle: IndexLifecycle;
} {
  const index = createSessionIndex(options);
  const unsupported = async (): Promise<never> => {
    throw new Error("unused timing-test lifecycle operation");
  };
  return {
    lifecycle: {
      async openWriter() {
        return {
          state: {
            status: "ready" as const,
            initialized: true as const,
            schemaVersion: 3,
            supportedSchemaVersion: 3,
          },
          sessions: index,
          workspace: syntheticCaptureWorkspace,
          async close() {
            if (Object.hasOwn(options, "closeError")) throw options.closeError;
          },
        };
      },
      openReader: unsupported,
      inspect: unsupported,
      inspectHealth: unsupported,
    },
  };
}

function createSessionIndex(options: IndexHarnessOptions): SessionIndexWriter {
  const counts = mutableIndexCounts();
  const items: IndexRunItem[] = [];
  let activeRun: SessionIndexRun | undefined;

  return {
    async getFreshness(sessionIdentity) {
      return (
        options.freshness?.(sessionIdentity) ?? {
          status: "untracked" as const,
          identity: sessionIdentity,
        }
      );
    },
    async getSummary() {
      return undefined;
    },
    async getDocument() {
      return undefined;
    },
    async getSession() {
      return undefined;
    },
    async listTrackedIdentities() {
      return options.tracked ?? [];
    },
    async startRun({ source, startedAt }) {
      activeRun = {
        id: createSessionIndexRunId("timing-run"),
        source,
        startedAt,
      };
      return activeRun;
    },
    async recordUnchanged(_run, _observation: SessionObservation) {
      counts.discovered += 1;
      counts.unchanged += 1;
    },
    async recordFailure(_run, observation, failure) {
      counts.discovered += 1;
      counts.failed += 1;
      items.push({ identity: observation.identity, outcome: "failed", failure });
    },
    async replaceSession(_run, _replacement: ValidatedSessionReplacement) {
      counts.discovered += 1;
      counts.updated += 1;
    },
    async recordMissing(_run, sessionIdentity) {
      counts.missing += 1;
      items.push({ identity: sessionIdentity, outcome: "missing" });
    },
    async finishRun(run, completion) {
      if (run !== activeRun) throw new Error("unexpected timing-test run");
      return finishResult(run, completion, counts, items);
    },
  };
}

function finishResult(
  run: SessionIndexRun,
  completion: FinishIndexRunInput,
  counts: IndexRunCounts,
  items: readonly IndexRunItem[],
): IndexRunResult {
  const common = {
    source: run.source,
    startedAt: run.startedAt,
    finishedAt: completion.finishedAt,
    counts: { ...counts },
    items: [...items],
    omittedItemCount: 0,
  };
  return completion.status === "completed"
    ? {
        ...common,
        status: "completed",
        coverage: { status: "complete", observedAt: run.startedAt },
      }
    : {
        ...common,
        status: "incomplete",
        coverage: { status: "unknown", observedAt: run.startedAt },
        failure: completion.failure,
      };
}

function currentFreshness(
  sessionIdentity: SessionIdentity,
  lastGood: SessionRevision,
): SessionFreshness {
  return {
    status: "current",
    identity: sessionIdentity,
    lastGood,
    latest: { outcome: "unchanged", revision: lastGood },
  };
}

function revision(candidate: DiscoveredSession): SessionRevision {
  return {
    aggregateFingerprint: candidate.aggregateFingerprint,
    adapterVersion: candidate.adapterVersion,
  };
}

interface PhaseCounter {
  readonly recorder: IndexTimingRecorder;
  snapshot(): Readonly<Record<IndexTimingPhase, number>>;
}

function createPhaseCounter(): PhaseCounter {
  let now = 0;
  const calls = new Map<IndexTimingPhase, number>(INDEX_TIMING_PHASES.map((phase) => [phase, 0]));
  return {
    recorder: {
      now: () => ++now,
      record(phase) {
        calls.set(phase, (calls.get(phase) ?? 0) + 1);
      },
    },
    snapshot() {
      return Object.fromEntries(
        INDEX_TIMING_PHASES.map((phase) => [phase, calls.get(phase) ?? 0]),
      ) as Record<IndexTimingPhase, number>;
    },
  };
}

function phaseCalls(
  overrides: Partial<Record<IndexTimingPhase, number>> = {},
): Readonly<Record<IndexTimingPhase, number>> {
  return {
    sourceResolution: 0,
    writerOpen: 1,
    writerFullValidationCanonical: 0,
    writerFullValidationForeignKeys: 0,
    writerFullValidationFtsStructure: 0,
    writerFullValidationFtsContent: 0,
    writerFullValidationFtsSemantic: 0,
    writerFullValidationFtsRebuild: 0,
    sourceProbe: 1,
    sourceDiscovery: 1,
    freshnessRead: 0,
    unchangedWrite: 0,
    changedReadAndNormalize: 0,
    replacement: 0,
    reconciliation: 1,
    runBookkeeping: 2,
    writerClose: 1,
    total: 0,
    ...overrides,
  };
}

function mutableIndexCounts(): {
  discovered: number;
  unchanged: number;
  updated: number;
  failed: number;
  missing: number;
  stale: number;
} {
  return { discovered: 0, unchanged: 0, updated: 0, failed: 0, missing: 0, stale: 0 };
}

function indexCounts(overrides: Partial<IndexRunCounts> = {}): Readonly<IndexRunCounts> {
  return { discovered: 0, unchanged: 0, updated: 0, failed: 0, missing: 0, stale: 0, ...overrides };
}

function identity(source: SourceInstance, nativeId: string): SessionIdentity {
  return { source, nativeId };
}

function clock(): IndexClock {
  let milliseconds = Date.parse("2026-07-16T12:00:00.000Z");
  return {
    now() {
      const value = new Date(milliseconds);
      milliseconds += 1_000;
      return value;
    },
  };
}
