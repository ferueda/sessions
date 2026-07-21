import path from "node:path";

import { describe, expect, test } from "vitest";

import { exportSession } from "../../src/application/export-session.ts";
import { listSessionEntries } from "../../src/application/list-session-entries.ts";
import { listSessions } from "../../src/application/list-sessions.ts";
import type { IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import type { SelectedSessionSource } from "../../src/application/ports/session-source.ts";
import { runIndex } from "../../src/application/run-index.ts";
import { searchSessions } from "../../src/application/search-sessions.ts";
import { showSession } from "../../src/application/show-session.ts";
import { runCli, type CliOptions } from "../../src/cli/run.ts";
import { formatSessionIdentity } from "../../src/domain/session-identity.ts";
import type { SessionIdentity } from "../../src/domain/session.ts";
import { createSqliteIndexLifecycle } from "../../src/infrastructure/sqlite/database.ts";

const SHARED_TEXT = "provideracceptancemarker";
const SHARED_CONTENT_HASH = {
  scheme: "sha256-utf8-v1",
  digest: "140eba5dbc14cfb3d9352da8f715c0645da16c9ff7cc95fd3c0974646eb93231",
} as const;
const DOCUMENT_DIGEST_SCHEME = "sha256-sessions-document-jcs-v1";

export interface ProviderWorkflowFixture {
  readonly root: string;
  readonly selected: SelectedSessionSource;
  readonly targetIdentity: SessionIdentity;
  readonly relatedIdentity: SessionIdentity;
  readonly expectedLineageCoverage: "complete" | "unknown";
  readonly expectedDocumentDigests: {
    readonly initial: string;
    readonly changed: string;
  };
  readonly expectedSupport: {
    readonly occurrences: number;
    readonly uniqueContent: number;
    readonly uniqueKnownRoots: number;
    readonly unknownLineageSessions: number;
  };
  snapshotProvider(): unknown | Promise<unknown>;
  changeTarget(): void | Promise<void>;
  omitTarget(): void | Promise<void>;
  restoreTarget(): void | Promise<void>;
  makeUnavailable(): void | Promise<void>;
  makeAvailable(): void | Promise<void>;
  makeTargetMalformed(): void | Promise<void>;
  recoverTarget(): void | Promise<void>;
  dispose(): void | Promise<void>;
}

export type ProviderWorkflowFactory = () =>
  | ProviderWorkflowFixture
  | Promise<ProviderWorkflowFixture>;

export { SHARED_TEXT as PROVIDER_WORKFLOW_SHARED_TEXT };

export function registerProviderWorkflowContract(
  name: string,
  createFixture: ProviderWorkflowFactory,
): void {
  describe(`${name} provider workflow acceptance`, () => {
    test("uses the shared index and query semantics without mutating provider state", async () => {
      expect.hasAssertions();
      const fixture = await createFixture();
      try {
        await exerciseProviderWorkflow(fixture);
      } finally {
        await fixture.dispose();
      }
    });
  });
}

async function exerciseProviderWorkflow(fixture: ProviderWorkflowFixture): Promise<void> {
  const paths = indexPaths(fixture.root);
  const lifecycle = createSqliteIndexLifecycle({
    now: monotonicNow("2026-07-20T12:00:00.000Z", 100),
    writerToken: tokenFactory(fixture.selected.adapter.kind),
  });
  const indexClock = { now: monotonicNow("2026-07-20T13:00:00.000Z", 1_000) };
  const invoke = createInvocation(fixture.selected, paths, lifecycle, indexClock);
  const targetId = formatSessionIdentity(fixture.targetIdentity);
  const relatedId = formatSessionIdentity(fixture.relatedIdentity);
  const expectedSessionOrder = [relatedId, targetId];
  const sourceFilter = [
    "--source",
    fixture.targetIdentity.source.kind,
    "--instance",
    fixture.targetIdentity.source.instanceId,
  ];
  const targetFilter = [...sourceFilter, "--native-id", fixture.targetIdentity.nativeId];

  const first = await invokeReadOnly(fixture, invoke, [
    "index",
    "--source",
    fixture.selected.adapter.kind,
    "--format",
    "json",
  ]);
  expect(first.exitCode).toBe(0);
  expect(json(first).counts).toEqual(counts({ discovered: 2, updated: 2 }));

  const stable = await invokeReadOnly(fixture, invoke, [
    "index",
    "--source",
    fixture.selected.adapter.kind,
    "--format",
    "json",
  ]);
  expect(stable.exitCode).toBe(0);
  expect(json(stable).counts).toEqual(counts({ discovered: 2, unchanged: 2 }));

  const completeList = json(
    await invokeReadOnly(fixture, invoke, ["list", ...sourceFilter, "--format", "json"]),
  );
  const repeatedList = json(
    await invokeReadOnly(fixture, invoke, ["list", ...sourceFilter, "--format", "json"]),
  );
  expect(completeList.sessions).toEqual(repeatedList.sessions);
  expect(canonicalIds(completeList.sessions)).toEqual(expectedSessionOrder);

  const listed = json(
    await invokeReadOnly(fixture, invoke, ["list", ...targetFilter, "--format", "json"]),
  );
  expect(listed.sessions).toHaveLength(1);
  expect(listed.sessions[0]).toMatchObject({
    session: { canonicalId: targetId },
    freshness: "current",
    sourceState: "present",
  });
  expect(listed.captureScope).toMatchObject({
    status: "complete",
    trackedSessions: 1,
    retainedSessions: { current: 1, stale: 0 },
    appliedFilters: ["source", "instance", "nativeId"],
  });

  const search = json(
    await invokeReadOnly(fixture, invoke, [
      "search",
      SHARED_TEXT,
      ...sourceFilter,
      "--format",
      "json",
    ]),
  );
  expect(search.support).toEqual(fixture.expectedSupport);
  expect(
    search.hits.map((hit) => ({
      session: canonicalId(hit.session),
      entry: {
        ordinal: hit.entry.ordinal,
        kind: hit.entry.kind,
        actor: hit.entry.actor,
      },
      match: {
        segmentOrdinal: hit.match.segmentOrdinal,
        origin: hit.match.origin,
        originConfidence: hit.match.originConfidence,
        excerpt: hit.match.excerpt,
        contentHash: hit.match.contentHash,
        additionalMatchingSegments: hit.match.additionalMatchingSegments,
        matchedTerms: hit.match.matchedTerms,
      },
    })),
  ).toEqual(
    expectedSessionOrder.map((session) => ({
      session,
      entry: { ordinal: 0, kind: "message", actor: "human" },
      match: {
        segmentOrdinal: 0,
        origin: "human",
        originConfidence: "high",
        excerpt: { text: SHARED_TEXT, truncated: false },
        contentHash: SHARED_CONTENT_HASH,
        additionalMatchingSegments: 0,
        matchedTerms: [SHARED_TEXT],
      },
    })),
  );
  expect(search.captureScope).toMatchObject({ status: "complete", trackedSessions: 2 });
  const repeatedSearch = json(
    await invokeReadOnly(fixture, invoke, [
      "search",
      SHARED_TEXT,
      ...sourceFilter,
      "--format",
      "json",
    ]),
  );
  expect(repeatedSearch.hits).toEqual(search.hits);
  expect(repeatedSearch.support).toEqual(search.support);

  const entries = json(
    await invokeReadOnly(fixture, invoke, ["entries", ...targetFilter, "--format", "json"]),
  );
  expect(entries.entries.map((entry) => entry.coordinate.ordinal)).toEqual([0]);
  expect(entries.entries[0]).toMatchObject({
    session: { session: { canonicalId: targetId } },
    coordinate: { kind: "message", actor: "human" },
  });

  const shown = json(await invokeReadOnly(fixture, invoke, ["show", targetId, "--format", "json"]));
  const initialDigest = shown.snapshot.documentDigest;
  expect(initialDigest).toEqual({
    scheme: DOCUMENT_DIGEST_SCHEME,
    digest: fixture.expectedDocumentDigests.initial,
  });
  expect(shown.snapshot).toMatchObject({
    session: { canonicalId: targetId },
    freshness: "current",
    sourceState: "present",
  });
  expect(shown.snapshot).toMatchObject({ lineageCoverage: fixture.expectedLineageCoverage });
  expect(shown.entries.map((entry) => entry.ordinal)).toEqual([0]);

  const exported = json(
    await invokeReadOnly(fixture, invoke, ["export", targetId, "--format", "json", "--full"]),
  );
  expect(exported.snapshot).toMatchObject({
    documentDigest: initialDigest,
    selection: { mode: "full" },
  });
  expect(exported.entries).toEqual(shown.entries);

  await fixture.changeTarget();
  const changed = json(
    await invokeReadOnly(fixture, invoke, [
      "index",
      "--source",
      fixture.selected.adapter.kind,
      "--format",
      "json",
    ]),
  );
  expect(changed.counts).toEqual(counts({ discovered: 2, unchanged: 1, updated: 1 }));
  const changedShow = json(
    await invokeReadOnly(fixture, invoke, ["show", targetId, "--format", "json"]),
  );
  const changedDigest = changedShow.snapshot.documentDigest;
  expect(changedDigest).toEqual({
    scheme: DOCUMENT_DIGEST_SCHEME,
    digest: fixture.expectedDocumentDigests.changed,
  });

  await fixture.omitTarget();
  const missing = json(
    await invokeReadOnly(fixture, invoke, [
      "index",
      "--source",
      fixture.selected.adapter.kind,
      "--format",
      "json",
    ]),
  );
  expect(missing.counts).toEqual(counts({ discovered: 1, unchanged: 1, missing: 1 }));
  expect(
    json(await invokeReadOnly(fixture, invoke, ["show", targetId, "--format", "json"])).snapshot,
  ).toMatchObject({
    documentDigest: changedDigest,
    freshness: "current",
    sourceState: "missing",
  });

  await fixture.restoreTarget();
  const restored = json(
    await invokeReadOnly(fixture, invoke, [
      "index",
      "--source",
      fixture.selected.adapter.kind,
      "--format",
      "json",
    ]),
  );
  expect(restored.counts).toEqual(counts({ discovered: 2, unchanged: 2 }));
  expect(
    json(await invokeReadOnly(fixture, invoke, ["show", targetId, "--format", "json"])).snapshot,
  ).toMatchObject({
    documentDigest: changedDigest,
    freshness: "current",
    sourceState: "present",
  });

  await fixture.makeUnavailable();
  const unavailable = await invokeReadOnly(fixture, invoke, [
    "index",
    "--source",
    fixture.selected.adapter.kind,
    "--format",
    "json",
  ]);
  expect(unavailable.exitCode).toBe(1);
  expect(json(unavailable)).toMatchObject({
    counts: counts({}),
    incompleteSources: 1,
    sources: [{ status: "incomplete", coverage: { status: "unknown" } }],
  });
  expect(
    json(await invokeReadOnly(fixture, invoke, ["list", ...sourceFilter, "--format", "json"]))
      .captureScope,
  ).toMatchObject({
    status: "incomplete",
    trackedSessions: 2,
    sourceCoverage: { complete: 0, unknown: 1 },
  });

  await fixture.makeAvailable();
  expect(
    json(
      await invokeReadOnly(fixture, invoke, [
        "index",
        "--source",
        fixture.selected.adapter.kind,
        "--format",
        "json",
      ]),
    ).counts,
  ).toEqual(counts({ discovered: 2, unchanged: 2 }));

  await fixture.makeTargetMalformed();
  const malformed = json(
    await invokeReadOnly(fixture, invoke, [
      "index",
      "--source",
      fixture.selected.adapter.kind,
      "--format",
      "json",
    ]),
  );
  expect(malformed).toMatchObject({
    counts: counts({ discovered: 2, unchanged: 1, failed: 1, stale: 1 }),
    sources: [{ status: "completed", items: [{ outcome: "failed", failure: "malformed" }] }],
  });
  expect(
    json(await invokeReadOnly(fixture, invoke, ["show", targetId, "--format", "json"])).snapshot,
  ).toMatchObject({
    documentDigest: changedDigest,
    freshness: "stale",
    sourceState: "present",
  });

  await fixture.recoverTarget();
  expect(
    json(
      await invokeReadOnly(fixture, invoke, [
        "index",
        "--source",
        fixture.selected.adapter.kind,
        "--format",
        "json",
      ]),
    ).counts,
  ).toEqual(counts({ discovered: 2, unchanged: 1, updated: 1 }));
}

function createInvocation(
  selected: SelectedSessionSource,
  paths: IndexPaths,
  lifecycle: ReturnType<typeof createSqliteIndexLifecycle>,
  clock: { readonly now: () => Date },
) {
  const options: CliOptions = {
    version: "1.0.0-acceptance",
    output: { writeOut() {}, writeErr() {} },
    doctor: async () => {
      throw new Error("acceptance fixture does not use doctor");
    },
    paths: async () => {
      throw new Error("acceptance fixture does not use paths");
    },
    indexSources: [selected.adapter.kind],
    index: async () =>
      runIndex({ paths, sources: [selected], sourceSelection: "required", lifecycle, clock }),
    list: (input) => listSessions({ paths, lifecycle, ...input }),
    entries: (input) => listSessionEntries({ paths, lifecycle, ...input }),
    search: (input) => searchSessions({ paths, lifecycle, ...input }),
    show: (input) => showSession({ paths, lifecycle, ...input }),
    export: (input) => exportSession({ paths, lifecycle, ...input }),
    forget: async () => {
      throw new Error("acceptance fixture does not use forget");
    },
    clearData: async () => {
      throw new Error("acceptance fixture does not use data clear");
    },
    compactData: async () => {
      throw new Error("acceptance fixture does not use data compact");
    },
    repairOrphanedData: async () => {
      throw new Error("acceptance fixture does not use orphan repair");
    },
  };
  return async (argv: readonly string[]): Promise<InvocationResult> => {
    let stdout = "";
    let stderr = "";
    const exitCode = await runCli(argv, {
      ...options,
      output: {
        writeOut: (value) => {
          stdout += value;
        },
        writeErr: (value) => {
          stderr += value;
        },
      },
    });
    return { exitCode, stdout, stderr };
  };
}

interface InvocationResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function invokeReadOnly(
  fixture: ProviderWorkflowFixture,
  invoke: (argv: readonly string[]) => Promise<InvocationResult>,
  argv: readonly string[],
): Promise<InvocationResult> {
  const before = await fixture.snapshotProvider();
  try {
    const result = await invoke(argv);
    expect(result.stderr).toBe("");
    return result;
  } finally {
    expect(await fixture.snapshotProvider()).toEqual(before);
  }
}

interface AcceptanceJson {
  readonly counts: Record<CountName, number>;
  readonly sessions: readonly Record<string, unknown>[];
  readonly captureScope: Record<string, unknown>;
  readonly hits: readonly {
    readonly session: Record<string, unknown>;
    readonly entry: {
      readonly ordinal: number;
      readonly kind: string;
      readonly actor: string;
    };
    readonly match: {
      readonly segmentOrdinal: number;
      readonly origin: string;
      readonly originConfidence: string;
      readonly excerpt: { readonly text: string; readonly truncated: boolean };
      readonly contentHash: { readonly scheme: string; readonly digest: string };
      readonly additionalMatchingSegments: number;
      readonly matchedTerms: readonly string[];
    };
  }[];
  readonly support: unknown;
  readonly entries: readonly {
    readonly ordinal: number;
    readonly coordinate: { readonly ordinal: number };
  }[];
  readonly snapshot: {
    readonly documentDigest: unknown;
    readonly [key: string]: unknown;
  };
  readonly sources: readonly unknown[];
  readonly incompleteSources: number;
}

function canonicalId(summary: Record<string, unknown>): string {
  const value = summary.session;
  if (
    value === null ||
    typeof value !== "object" ||
    !("canonicalId" in value) ||
    typeof value.canonicalId !== "string"
  ) {
    throw new TypeError("Acceptance summary has no canonical ID");
  }
  return value.canonicalId;
}

function json(result: InvocationResult): AcceptanceJson {
  expect(result.stdout).not.toBe("");
  return JSON.parse(result.stdout) as AcceptanceJson;
}

function counts(overrides: Partial<Record<CountName, number>>): Record<CountName, number> {
  return {
    discovered: 0,
    unchanged: 0,
    updated: 0,
    failed: 0,
    missing: 0,
    stale: 0,
    ...overrides,
  };
}

function canonicalIds(sessions: readonly Record<string, unknown>[]): string[] {
  return sessions.map((summary) => {
    const session = summary.session;
    if (
      session === null ||
      typeof session !== "object" ||
      !("canonicalId" in session) ||
      typeof session.canonicalId !== "string"
    ) {
      throw new TypeError("Acceptance list summary has no canonical ID");
    }
    return session.canonicalId;
  });
}

type CountName = "discovered" | "unchanged" | "updated" | "failed" | "missing" | "stale";

function indexPaths(root: string): IndexPaths {
  const directory = path.join(root, "acceptance-library");
  const database = path.join(directory, "sessions.sqlite3");
  return {
    directory,
    scratch: path.join(directory, ".scratch"),
    database,
    wal: `${database}-wal`,
    shm: `${database}-shm`,
  };
}

function monotonicNow(iso: string, incrementMs: number): () => Date {
  let milliseconds = Date.parse(iso) - incrementMs;
  return () => {
    milliseconds += incrementMs;
    return new Date(milliseconds);
  };
}

function tokenFactory(prefix: string): () => string {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}
