import { describe, expect, test, vi } from "vitest";

import type { IndexLifecycle } from "../../src/application/ports/index-lifecycle.ts";
import type {
  FinishIndexRunInput,
  IndexRunFailureCode,
  IndexRunItem,
  IndexRunResult,
  RecordableSessionFailureCode,
  SessionFreshness,
  SessionIndexRun,
  SessionIndexWriter,
} from "../../src/application/ports/session-index.ts";
import type {
  SelectedSessionSource,
  SourceProbe,
  SourceProbeStatus,
} from "../../src/application/ports/session-source.ts";
import { runIndex, type IndexClock } from "../../src/application/run-index.ts";
import type {
  SessionObservation,
  ValidatedSessionReplacement,
} from "../../src/application/validate-session.ts";
import { SourceFailureError } from "../../src/application/source-failure.ts";
import { formatSessionIdentity } from "../../src/domain/session-identity.ts";
import type { SessionDocument, SessionIdentity, SourceInstance } from "../../src/domain/session.ts";
import { createFakeIndexingSource, type FakeIndexingSource } from "../fixtures/indexing-source.ts";
import { syntheticCaptureWorkspace } from "../fixtures/capture-workspace.ts";

const paths = {
  directory: "/tmp/sessions-test",
  scratch: "/tmp/sessions-test/.scratch",
  database: "/tmp/sessions-test/sessions.sqlite3",
  wal: "/tmp/sessions-test/sessions.sqlite3-wal",
  shm: "/tmp/sessions-test/sessions.sqlite3-shm",
};

interface ProbeFailureCase {
  readonly label: string;
  readonly configure: (source: FakeIndexingSource) => void;
  readonly failure: IndexRunFailureCode;
}

const PROBE_FAILURE_CASES: readonly ProbeFailureCase[] = [
  {
    label: "returned unavailable probe",
    configure: (source) => source.setProbe(probe(source, "unavailable")),
    failure: "source-unavailable",
  },
  {
    label: "typed thrown unavailable probe",
    configure: (source) =>
      source.failProbe(new SourceFailureError({ kind: "unavailable", source: source.instance })),
    failure: "source-unavailable",
  },
  {
    label: "returned unreadable probe",
    configure: (source) => source.setProbe(probe(source, "unreadable")),
    failure: "source-unreadable",
  },
  {
    label: "typed thrown unreadable probe",
    configure: (source) =>
      source.failProbe(new SourceFailureError({ kind: "unreadable", source: source.instance })),
    failure: "source-unreadable",
  },
  {
    label: "malformed returned probe",
    configure: (source) => source.setProbe({} as SourceProbe),
    failure: "probe-failed",
  },
  {
    label: "unexpected thrown probe error",
    configure: (source) => source.failProbe(new Error("private probe failure")),
    failure: "probe-failed",
  },
  {
    label: "invalid typed probe failure",
    configure: (source) =>
      source.failProbe(new SourceFailureError({ kind: "malformed", source: source.instance })),
    failure: "probe-failed",
  },
  {
    label: "wrong-source typed probe failure",
    configure: (source) =>
      source.failProbe(
        new SourceFailureError({
          kind: "unreadable",
          source: { ...source.instance, instanceId: "other" },
        }),
      ),
    failure: "probe-failed",
  },
];

function probe(source: FakeIndexingSource, status: SourceProbeStatus): SourceProbe {
  return {
    source: source.instance,
    status,
    locations: [{ role: "root", locator: { uri: "memory://sessions" } }],
    summary: `Synthetic source is ${status}`,
  };
}

describe("runIndex", () => {
  test("passes the opened writer workspace into discovery and changed reads", async () => {
    const source = createFakeIndexingSource();
    source.setDiscovery([source.candidate("session")]);
    const harness = createIndexHarness();

    await execute(harness, [source.selected]);

    expect(source.discoveryWorkspaces).toEqual([syntheticCaptureWorkspace]);
    expect(source.readWorkspaces).toEqual([syntheticCaptureWorkspace]);
  });

  test("rejects duplicate selections before opening the index", async () => {
    const source = createFakeIndexingSource();
    const harness = createIndexHarness();

    await expect(
      runIndex({
        paths,
        sources: [source.selected, source.selected],
        lifecycle: harness.lifecycle,
        clock: clock(),
      }),
    ).rejects.toThrow("Duplicate selected source instance");

    expect(harness.openWriter).not.toHaveBeenCalled();
  });

  test("maps writer contention to the public library-busy failure", async () => {
    const source = createFakeIndexingSource();
    const harness = createIndexHarness();
    const busy = Object.assign(new Error("internal lease detail"), { code: "writer-busy" });
    harness.openWriter.mockRejectedValue(busy);

    await expect(execute(harness, [source.selected])).rejects.toMatchObject({
      code: "library-busy",
      message: "Session library is busy",
      cause: busy,
    });
  });

  test("sorts sources and continues after unavailable and malformed probes", async () => {
    const unavailable = createFakeIndexingSource({ kind: "alpha", instanceId: "two" });
    unavailable.failProbe(
      new SourceFailureError({ kind: "unavailable", source: unavailable.instance }),
    );
    const malformed = createFakeIndexingSource({ kind: "alpha", instanceId: "one" });
    malformed.setProbe({} as never);
    const ready = createFakeIndexingSource({ kind: "zeta", instanceId: "one" });
    ready.setDiscovery([ready.candidate("session")]);
    const harness = createIndexHarness();

    const report = await runIndex({
      paths,
      sources: [ready.selected, unavailable.selected, malformed.selected],
      lifecycle: harness.lifecycle,
      clock: clock(),
    });

    expect(harness.index.startedSources).toEqual([
      { kind: "alpha", instanceId: "one" },
      { kind: "alpha", instanceId: "two" },
      { kind: "zeta", instanceId: "one" },
    ]);
    expect(
      report.sources.map(({ status, ...sourceReport }) => ({
        source: sourceReport.source,
        status,
        ...("failure" in sourceReport ? { failure: sourceReport.failure } : {}),
      })),
    ).toEqual([
      { source: malformed.instance, status: "incomplete", failure: "probe-failed" },
      {
        source: unavailable.instance,
        status: "incomplete",
        failure: "source-unavailable",
      },
      { source: ready.instance, status: "completed" },
    ]);
    expect(report).toMatchObject({
      schemaVersion: 1,
      command: "index",
      counts: { discovered: 1, unchanged: 0, updated: 1, failed: 0, missing: 0 },
      incompleteSources: 2,
      omittedItemCount: 0,
    });
    expect(ready.readNativeIds).toEqual(["session"]);
  });

  test.each(PROBE_FAILURE_CASES)(
    "finalizes $label without session mutation and continues",
    async ({ configure, failure }) => {
      const failed = createFakeIndexingSource({ kind: "alpha", instanceId: "failed" });
      failed.setDiscovery([failed.candidate("must-not-read")]);
      configure(failed);
      const ready = createFakeIndexingSource({ kind: "zeta", instanceId: "ready" });
      ready.setDiscovery([ready.candidate("indexed")]);
      const harness = createIndexHarness();

      const report = await execute(harness, [ready.selected, failed.selected]);

      expect(report.sources[0]).toMatchObject({
        source: failed.instance,
        status: "incomplete",
        failure,
        counts: emptyCounts(),
        items: [],
        omittedItemCount: 0,
      });
      expect(report.sources[1]).toMatchObject({
        source: ready.instance,
        status: "completed",
        counts: { discovered: 1, updated: 1 },
      });
      expect(failed.readNativeIds).toEqual([]);
      await expect(harness.index.listTrackedIdentities(failed.instance)).resolves.toEqual([]);
      expect(ready.readNativeIds).toEqual(["indexed"]);
    },
  );

  test("skips unchanged reads and invalidates freshness when adapter version changes", async () => {
    const source = createFakeIndexingSource();
    const candidate = source.candidate("session", "revision-one", "adapter-v1");
    source.setDiscovery([candidate]);
    const harness = createIndexHarness();

    const first = await execute(harness, [source.selected]);
    const second = await execute(harness, [source.selected]);
    source.setDiscovery([source.candidate("session", "revision-one", "adapter-v2")]);
    const third = await execute(harness, [source.selected]);

    expect(source.readNativeIds).toEqual(["session", "session"]);
    expect(source.readWorkspaces).toEqual([syntheticCaptureWorkspace, syntheticCaptureWorkspace]);
    expect(first.counts).toMatchObject({ discovered: 1, updated: 1, unchanged: 0 });
    expect(second.counts).toMatchObject({ discovered: 1, updated: 0, unchanged: 1 });
    expect(third.counts).toMatchObject({ discovered: 1, updated: 1, unchanged: 0 });
  });

  test("keeps failed reads seen and preserves last-good freshness", async () => {
    const source = createFakeIndexingSource();
    source.setDiscovery([source.candidate("session", "revision-one")]);
    const harness = createIndexHarness();
    await execute(harness, [source.selected]);

    source.setDiscovery([source.candidate("session", "revision-two")]);
    source.failRead("session", "source-changed");
    const report = await execute(harness, [source.selected]);

    expect(report.counts).toEqual({
      discovered: 1,
      unchanged: 0,
      updated: 0,
      failed: 1,
      missing: 0,
      stale: 1,
    });
    expect(report.sources[0]?.items).toMatchObject([
      {
        identity: { source: source.instance, nativeId: "session" },
        outcome: "failed",
        failure: "source-changed",
      },
    ]);
    expect(await harness.index.getFreshness(identity(source.instance, "session"))).toMatchObject({
      status: "stale",
    });
  });

  test("does not rediscover after a terminal non-source-change failure", async () => {
    const source = createFakeIndexingSource();
    source.setDiscovery([source.candidate("session")]);
    source.failNextRead("session", "malformed");
    const harness = createIndexHarness();

    const report = await execute(harness, [source.selected]);

    expect(report.counts).toEqual({
      discovered: 1,
      unchanged: 0,
      updated: 0,
      failed: 1,
      missing: 0,
      stale: 0,
    });
    expect(source.probeCount).toBe(1);
    expect(source.discoveryWorkspaces).toEqual([syntheticCaptureWorkspace]);
    expect(source.readWorkspaces).toEqual([syntheticCaptureWorkspace]);
    expect(source.readNativeIds).toEqual(["session"]);
  });

  test("recovers multiple changed sessions through one ordered fresh discovery", async () => {
    const source = createFakeIndexingSource();
    const primaryA = source.candidate("a-session", "primary-a");
    const primaryB = source.candidate("b-session", "primary-b");
    const freshA = source.candidate("a-session", "fresh-a");
    const freshB = source.candidate("b-session", "fresh-b");
    const retryOnly = source.candidate("retry-only", "fresh-new");
    source.queueDiscoveries(
      { candidates: [primaryB, primaryA] },
      { candidates: [retryOnly, freshB, freshA] },
    );
    source.failNextRead("a-session", "source-changed");
    source.failNextRead("b-session", "source-changed");
    const harness = createIndexHarness();

    const report = await execute(harness, [source.selected]);

    expect(report.counts).toEqual({
      discovered: 2,
      unchanged: 0,
      updated: 2,
      failed: 0,
      missing: 0,
      stale: 0,
    });
    expect(report.sources[0]?.items).toEqual([]);
    expect(source.probeCount).toBe(1);
    expect(source.discoveryWorkspaces).toEqual([
      syntheticCaptureWorkspace,
      syntheticCaptureWorkspace,
    ]);
    expect(source.readNativeIds).toEqual(["a-session", "b-session", "a-session", "b-session"]);
    expect(source.readWorkspaces).toEqual([
      syntheticCaptureWorkspace,
      syntheticCaptureWorkspace,
      syntheticCaptureWorkspace,
      syntheticCaptureWorkspace,
    ]);
    await expect(harness.index.getFreshness(primaryA.identity)).resolves.toMatchObject({
      status: "current",
      latest: { revision: { aggregateFingerprint: freshA.aggregateFingerprint } },
    });
    await expect(harness.index.getFreshness(primaryB.identity)).resolves.toMatchObject({
      status: "current",
      latest: { revision: { aggregateFingerprint: freshB.aggregateFingerprint } },
    });
    await expect(harness.index.getFreshness(retryOnly.identity)).resolves.toMatchObject({
      status: "untracked",
    });
    expect(harness.index.recordFailureCalls).toBe(0);
  });

  test("uses fresh last-good state while keeping retry-only identities out of coverage", async () => {
    const source = createFakeIndexingSource();
    const lastGood = source.candidate("kept", "revision-one");
    const laterMissing = source.candidate("later-missing", "revision-one");
    source.setDiscovery([laterMissing, lastGood]);
    const harness = createIndexHarness();
    await execute(harness, [source.selected]);
    const readsAfterBaseline = source.readNativeIds.length;

    const primaryChanged = source.candidate("kept", "revision-two");
    const retryOnlyMissing = source.candidate("later-missing", "revision-two");
    const retryOnlyNew = source.candidate("new-session", "revision-one");
    source.queueDiscoveries(
      { candidates: [primaryChanged] },
      { candidates: [retryOnlyNew, retryOnlyMissing, lastGood] },
    );
    source.failNextRead("kept", "source-changed");

    const report = await execute(harness, [source.selected]);

    expect(report.counts).toEqual({
      discovered: 1,
      unchanged: 1,
      updated: 0,
      failed: 0,
      missing: 1,
      stale: 0,
    });
    expect(report.sources[0]?.items).toMatchObject([
      { identity: { nativeId: "later-missing" }, outcome: "missing" },
    ]);
    expect(source.readNativeIds.slice(readsAfterBaseline)).toEqual(["kept"]);
    await expect(harness.index.getFreshness(lastGood.identity)).resolves.toMatchObject({
      status: "current",
      latest: {
        outcome: "unchanged",
        revision: { aggregateFingerprint: lastGood.aggregateFingerprint },
      },
    });
    await expect(harness.index.getFreshness(retryOnlyNew.identity)).resolves.toMatchObject({
      status: "untracked",
    });
  });

  test("discards partial retry discovery and reconciles missing from the primary snapshot", async () => {
    const source = createFakeIndexingSource();
    const laterMissing = source.candidate("later-missing", "revision-one");
    source.setDiscovery([laterMissing]);
    const harness = createIndexHarness();
    await execute(harness, [source.selected]);
    const readsAfterBaseline = source.readNativeIds.length;

    const primary = source.candidate("retry-target", "primary-revision");
    const fresh = source.candidate("retry-target", "fresh-revision");
    source.queueDiscoveries(
      { candidates: [primary] },
      {
        candidates: [fresh],
        failure: { error: new Error("private retry discovery failure"), afterCandidates: 1 },
      },
    );
    source.failNextRead("retry-target", "source-changed");

    const report = await execute(harness, [source.selected]);

    expect(report.sources[0]).toMatchObject({
      status: "completed",
      coverage: { status: "complete" },
      counts: { discovered: 1, failed: 1, missing: 1, stale: 0 },
      items: [
        {
          identity: { nativeId: "retry-target" },
          outcome: "failed",
          failure: "source-changed",
        },
        { identity: { nativeId: "later-missing" }, outcome: "missing" },
      ],
    });
    expect(source.readNativeIds.slice(readsAfterBaseline)).toEqual(["retry-target"]);
    await expect(harness.index.getFreshness(primary.identity)).resolves.toMatchObject({
      status: "unindexed",
      latest: { revision: { aggregateFingerprint: primary.aggregateFingerprint } },
    });
  });

  test("records one fresh terminal failure after an immediate primary failure", async () => {
    const source = createFakeIndexingSource();
    const lastGood = source.candidate("a-retry", "last-good");
    source.setDiscovery([lastGood]);
    const harness = createIndexHarness();
    await execute(harness, [source.selected]);

    const primary = source.candidate("a-retry", "primary-revision");
    const immediate = source.candidate("b-malformed", "primary-revision");
    const fresh = source.candidate("a-retry", "fresh-revision");
    source.queueDiscoveries({ candidates: [immediate, primary] }, { candidates: [fresh] });
    source.failNextRead("a-retry", "source-changed");
    source.failNextRead("a-retry", "source-changed");
    source.failNextRead("b-malformed", "malformed");

    const report = await execute(harness, [source.selected]);

    expect(report.counts).toEqual({
      discovered: 2,
      unchanged: 0,
      updated: 0,
      failed: 2,
      missing: 0,
      stale: 1,
    });
    expect(report.sources[0]?.items).toMatchObject([
      { identity: { nativeId: "b-malformed" }, outcome: "failed", failure: "malformed" },
      { identity: { nativeId: "a-retry" }, outcome: "failed", failure: "source-changed" },
    ]);
    expect(harness.index.recordFailureCalls).toBe(2);
    expect(source.readNativeIds).toEqual(["a-retry", "a-retry", "b-malformed", "a-retry"]);
    await expect(harness.index.getFreshness(primary.identity)).resolves.toMatchObject({
      status: "stale",
      latest: { revision: { aggregateFingerprint: fresh.aggregateFingerprint } },
    });
  });

  test("records a vanished retry target from its primary observation", async () => {
    const source = createFakeIndexingSource();
    const primary = source.candidate("vanished", "primary-revision");
    source.queueDiscoveries({ candidates: [primary] }, { candidates: [] });
    source.failNextRead("vanished", "source-changed");
    const harness = createIndexHarness();

    const report = await execute(harness, [source.selected]);

    expect(report.sources[0]).toMatchObject({
      status: "completed",
      counts: { discovered: 1, failed: 1, missing: 0, stale: 0 },
      items: [
        {
          identity: { nativeId: "vanished" },
          outcome: "failed",
          failure: "source-changed",
        },
      ],
    });
    expect(source.discoveryWorkspaces).toHaveLength(2);
    expect(source.readNativeIds).toEqual(["vanished"]);
    await expect(harness.index.getFreshness(primary.identity)).resolves.toMatchObject({
      status: "unindexed",
      latest: { revision: { aggregateFingerprint: primary.aggregateFingerprint } },
    });
  });

  test("does not rediscover a third time after a different final read failure", async () => {
    const source = createFakeIndexingSource();
    const primary = source.candidate("session", "primary-revision");
    const fresh = source.candidate("session", "fresh-revision");
    source.queueDiscoveries({ candidates: [primary] }, { candidates: [fresh] });
    source.failNextRead("session", "source-changed");
    source.failNextRead("session", "unreadable");
    const harness = createIndexHarness();

    const report = await execute(harness, [source.selected]);

    expect(report.counts).toMatchObject({ discovered: 1, failed: 1, stale: 0 });
    expect(report.sources[0]?.items).toMatchObject([
      { identity: { nativeId: "session" }, outcome: "failed", failure: "unreadable" },
    ]);
    expect(source.discoveryWorkspaces).toHaveLength(2);
    expect(source.readNativeIds).toEqual(["session", "session"]);
    await expect(harness.index.getFreshness(primary.identity)).resolves.toMatchObject({
      latest: { revision: { aggregateFingerprint: fresh.aggregateFingerprint } },
    });
  });

  test("performs no candidate mutation or reconciliation after incomplete discovery", async () => {
    const source = createFakeIndexingSource();
    source.setDiscovery([
      source.candidate("kept", "revision-one"),
      source.candidate("later-missing", "revision-one"),
    ]);
    const harness = createIndexHarness();
    await execute(harness, [source.selected]);
    const readsBefore = source.readNativeIds.length;

    source.setDiscovery([source.candidate("kept", "revision-two")]);
    source.failDiscovery(new Error("private iterator failure"), 1);
    const incomplete = await execute(harness, [source.selected]);

    expect(incomplete.sources[0]).toMatchObject({
      status: "incomplete",
      failure: "discovery-failed",
      counts: emptyCounts(),
    });
    expect(source.readNativeIds).toHaveLength(readsBefore);
    expect(await harness.index.listTrackedIdentities(source.instance)).toHaveLength(2);

    source.setDiscovery([source.candidate("kept", "revision-two")]);
    const complete = await execute(harness, [source.selected]);
    expect(complete.counts).toMatchObject({ discovered: 1, updated: 1, missing: 1 });
    expect(await harness.index.listTrackedIdentities(source.instance)).toHaveLength(2);
  });

  test("does not record a second failure after repository replacement rejects", async () => {
    const source = createFakeIndexingSource();
    source.setDiscovery([source.candidate("session")]);
    const operationError = new Error("repository replacement failed");
    const harness = createIndexHarness({ replaceError: operationError });

    await expect(execute(harness, [source.selected])).rejects.toBe(operationError);

    expect(harness.index.recordFailureCalls).toBe(0);
    expect(harness.index.finishedRuns).toHaveLength(1);
    expect(harness.index.finishedRuns[0]).toMatchObject({
      completion: { status: "incomplete", failure: "repository-write" },
      result: {
        counts: { discovered: 1, failed: 1, stale: 0 },
        items: [
          {
            identity: identity(source.instance, "session"),
            outcome: "failed",
            failure: "repository-write",
          },
        ],
      },
    });
  });

  test("aggregates independent operation, finalization, and close failures", async () => {
    const source = createFakeIndexingSource();
    source.setDiscovery([source.candidate("session")]);
    const operationError = new Error("repository operation failed");
    const finalizationError = new Error("repository finalization failed");
    const closeError = new Error("writer close failed");
    const harness = createIndexHarness({
      getFreshnessError: operationError,
      finishError: finalizationError,
      closeError,
    });

    const error = await captureError(execute(harness, [source.selected]));

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    const sourceError = (error as AggregateError).errors[0];
    expect(sourceError).toBeInstanceOf(AggregateError);
    expect((sourceError as AggregateError).errors).toEqual([operationError, finalizationError]);
    expect((error as AggregateError).errors[1]).toBe(closeError);
  });
});

async function execute(harness: IndexHarness, sources: readonly SelectedSessionSource[]) {
  return runIndex({ paths, sources, lifecycle: harness.lifecycle, clock: clock() });
}

interface IndexHarness {
  readonly lifecycle: IndexLifecycle;
  readonly index: MemorySessionIndex;
  readonly openWriter: ReturnType<typeof vi.fn>;
}

function createIndexHarness(
  options: MemoryIndexOptions & { readonly closeError?: unknown } = {},
): IndexHarness {
  const index = new MemorySessionIndex(options);
  const openWriter = vi.fn<IndexLifecycle["openWriter"]>(async () => ({
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
  }));
  const unsupported = async (): Promise<never> => {
    throw new Error("not used by runIndex");
  };
  return {
    index,
    openWriter,
    lifecycle: {
      openWriter,
      openReader: unsupported,
      inspect: unsupported,
      inspectHealth: unsupported,
    },
  };
}

interface MemoryIndexOptions {
  readonly replaceError?: unknown;
  readonly getFreshnessError?: unknown;
  readonly finishError?: unknown;
}

interface StoredSession {
  readonly identity: SessionIdentity;
  presence: "present" | "missing";
  lastGood?: SessionObservation["revision"];
  latest:
    | {
        readonly outcome: "indexed" | "unchanged";
        readonly revision: SessionObservation["revision"];
      }
    | {
        readonly outcome: "failed";
        readonly revision: SessionObservation["revision"];
        readonly failure: RecordableSessionFailureCode | "repository-write";
      };
}

interface MemoryRun {
  readonly run: SessionIndexRun;
  readonly counts: MutableCounts;
  readonly items: IndexRunItem[];
}

interface MutableCounts {
  discovered: number;
  unchanged: number;
  updated: number;
  failed: number;
  missing: number;
  stale: number;
}

class MemorySessionIndex implements SessionIndexWriter {
  readonly startedSources: SourceInstance[] = [];
  readonly finishedRuns: Array<{
    readonly completion: FinishIndexRunInput;
    readonly result: IndexRunResult;
  }> = [];
  recordFailureCalls = 0;
  readonly #sessions = new Map<string, StoredSession>();
  readonly #runs = new Map<string, MemoryRun>();
  readonly #options: MemoryIndexOptions;
  #nextRunId = 1;

  constructor(options: MemoryIndexOptions) {
    this.#options = options;
  }

  async getFreshness(sessionIdentity: SessionIdentity): Promise<SessionFreshness> {
    if (Object.hasOwn(this.#options, "getFreshnessError")) {
      throw this.#options.getFreshnessError;
    }
    const stored = this.#sessions.get(formatSessionIdentity(sessionIdentity));
    if (stored === undefined) return { status: "untracked", identity: sessionIdentity };
    if (stored.lastGood === undefined) {
      if (stored.latest.outcome !== "failed") throw new Error("invalid memory fixture state");
      return { status: "unindexed", identity: sessionIdentity, latest: stored.latest };
    }
    if (stored.latest.outcome === "failed") {
      return {
        status: "stale",
        identity: sessionIdentity,
        lastGood: stored.lastGood,
        latest: stored.latest,
      };
    }
    return {
      status: "current",
      identity: sessionIdentity,
      lastGood: stored.lastGood,
      latest: stored.latest,
    };
  }

  async getSummary() {
    return undefined;
  }

  async listSummaries() {
    return [];
  }

  async getDocument(): Promise<SessionDocument | undefined> {
    return undefined;
  }

  async getSession() {
    return undefined;
  }

  async listTrackedIdentities(source: SourceInstance): Promise<readonly SessionIdentity[]> {
    return [...this.#sessions.values()]
      .filter((stored) => sameSource(stored.identity.source, source))
      .map(({ identity: value }) => value)
      .sort((left, right) =>
        left.nativeId < right.nativeId ? -1 : left.nativeId > right.nativeId ? 1 : 0,
      );
  }

  async startRun(input: { readonly source: SourceInstance; readonly startedAt: string }) {
    const run: SessionIndexRun = {
      id: String(this.#nextRunId++) as SessionIndexRun["id"],
      source: { ...input.source },
      startedAt: input.startedAt,
    };
    this.startedSources.push(run.source);
    this.#runs.set(run.id, { run, counts: emptyCounts(), items: [] });
    return run;
  }

  async recordUnchanged(run: SessionIndexRun, observation: SessionObservation) {
    const active = this.#run(run);
    const stored = this.#requireStored(observation.identity);
    stored.latest = { outcome: "unchanged", revision: observation.revision };
    active.counts.discovered += 1;
    active.counts.unchanged += 1;
  }

  async recordFailure(
    run: SessionIndexRun,
    observation: SessionObservation,
    failure: RecordableSessionFailureCode,
  ) {
    this.recordFailureCalls += 1;
    this.#recordFailure(run, observation, failure);
  }

  async replaceSession(run: SessionIndexRun, replacement: ValidatedSessionReplacement) {
    if (Object.hasOwn(this.#options, "replaceError")) {
      this.#recordFailure(run, replacement.observation, "repository-write");
      throw this.#options.replaceError;
    }
    const active = this.#run(run);
    this.#sessions.set(formatSessionIdentity(replacement.observation.identity), {
      identity: replacement.observation.identity,
      presence: "present",
      lastGood: replacement.observation.revision,
      latest: { outcome: "indexed", revision: replacement.observation.revision },
    });
    active.counts.discovered += 1;
    active.counts.updated += 1;
  }

  async recordMissing(run: SessionIndexRun, sessionIdentity: SessionIdentity) {
    const active = this.#run(run);
    const stored = this.#sessions.get(formatSessionIdentity(sessionIdentity));
    if (stored === undefined) return;
    stored.presence = "missing";
    active.counts.missing += 1;
    active.items.push({ identity: sessionIdentity, outcome: "missing" });
  }

  async finishRun(run: SessionIndexRun, completion: FinishIndexRunInput): Promise<IndexRunResult> {
    if (Object.hasOwn(this.#options, "finishError")) throw this.#options.finishError;
    const active = this.#run(run);
    const common = {
      source: active.run.source,
      startedAt: active.run.startedAt,
      finishedAt: completion.finishedAt,
      counts: { ...active.counts },
      items: [...active.items],
      omittedItemCount: 0,
    };
    const result: IndexRunResult =
      completion.status === "completed"
        ? {
            ...common,
            status: "completed",
            coverage: { status: "complete", observedAt: active.run.startedAt },
          }
        : {
            ...common,
            status: "incomplete",
            coverage: { status: "unknown", observedAt: active.run.startedAt },
            failure: completion.failure,
          };
    this.#runs.delete(run.id);
    this.finishedRuns.push({ completion, result });
    return result;
  }

  #recordFailure(
    run: SessionIndexRun,
    observation: SessionObservation,
    failure: RecordableSessionFailureCode | "repository-write",
  ): void {
    const active = this.#run(run);
    const key = formatSessionIdentity(observation.identity);
    const previous = this.#sessions.get(key);
    const stale = previous?.lastGood !== undefined;
    this.#sessions.set(key, {
      identity: observation.identity,
      presence: "present",
      ...(previous?.lastGood === undefined ? {} : { lastGood: previous.lastGood }),
      latest: { outcome: "failed", revision: observation.revision, failure },
    });
    active.counts.discovered += 1;
    active.counts.failed += 1;
    if (stale) active.counts.stale += 1;
    active.items.push({ identity: observation.identity, outcome: "failed", failure });
  }

  #run(run: SessionIndexRun): MemoryRun {
    const active = this.#runs.get(run.id);
    if (active === undefined) throw new Error("invalid memory fixture run");
    return active;
  }

  #requireStored(sessionIdentity: SessionIdentity): StoredSession {
    const stored = this.#sessions.get(formatSessionIdentity(sessionIdentity));
    if (stored === undefined) throw new Error("missing memory fixture session");
    return stored;
  }
}

function clock(): IndexClock {
  let milliseconds = Date.parse("2026-07-13T12:00:00.000Z");
  return {
    now() {
      const value = new Date(milliseconds);
      milliseconds += 1_000;
      return value;
    },
  };
}

function identity(source: SourceInstance, nativeId: string): SessionIdentity {
  return { source, nativeId };
}

function sameSource(left: SourceInstance, right: SourceInstance): boolean {
  return left.kind === right.kind && left.instanceId === right.instanceId;
}

function emptyCounts(): MutableCounts {
  return { discovered: 0, unchanged: 0, updated: 0, failed: 0, missing: 0, stale: 0 };
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected rejection");
}
