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

const paths = {
  directory: "/tmp/sessions-test",
  database: "/tmp/sessions-test/index.sqlite3",
  wal: "/tmp/sessions-test/index.sqlite3-wal",
  shm: "/tmp/sessions-test/index.sqlite3-shm",
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
      counts: { discovered: 1, unchanged: 0, updated: 1, failed: 0, removed: 0 },
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
      await expect(harness.index.listIndexedIdentities(failed.instance)).resolves.toEqual([]);
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
      removed: 0,
      stale: 1,
    });
    expect(report.sources[0]?.items).toEqual([
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

  test("performs no candidate mutation or reconciliation after incomplete discovery", async () => {
    const source = createFakeIndexingSource();
    source.setDiscovery([
      source.candidate("kept", "revision-one"),
      source.candidate("later-removed", "revision-one"),
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
    expect(await harness.index.listIndexedIdentities(source.instance)).toHaveLength(2);

    source.setDiscovery([source.candidate("kept", "revision-two")]);
    const complete = await execute(harness, [source.selected]);
    expect(complete.counts).toMatchObject({ discovered: 1, updated: 1, removed: 1 });
    expect(await harness.index.listIndexedIdentities(source.instance)).toEqual([
      identity(source.instance, "kept"),
    ]);
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
      }
    | { readonly outcome: "removed" };
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
  removed: number;
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
    if (stored.latest.outcome === "removed") {
      return { status: "removed", identity: sessionIdentity, latest: stored.latest };
    }
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

  async getDocument(): Promise<SessionDocument | undefined> {
    return undefined;
  }

  async listIndexedIdentities(source: SourceInstance): Promise<readonly SessionIdentity[]> {
    return [...this.#sessions.values()]
      .filter(
        (stored) =>
          stored.lastGood !== undefined &&
          stored.latest.outcome !== "removed" &&
          sameSource(stored.identity.source, source),
      )
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
      lastGood: replacement.observation.revision,
      latest: { outcome: "indexed", revision: replacement.observation.revision },
    });
    active.counts.discovered += 1;
    active.counts.updated += 1;
  }

  async removeSession(run: SessionIndexRun, sessionIdentity: SessionIdentity) {
    const active = this.#run(run);
    const stored = this.#sessions.get(formatSessionIdentity(sessionIdentity));
    if (
      stored === undefined ||
      stored.lastGood === undefined ||
      stored.latest.outcome === "removed"
    ) {
      return;
    }
    delete stored.lastGood;
    stored.latest = { outcome: "removed" };
    active.counts.removed += 1;
    active.items.push({ identity: sessionIdentity, outcome: "removed" });
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
        ? { ...common, status: "completed" }
        : { ...common, status: "incomplete", failure: completion.failure };
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
  return { discovered: 0, unchanged: 0, updated: 0, failed: 0, removed: 0, stale: 0 };
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected rejection");
}
