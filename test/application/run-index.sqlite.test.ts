import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { IndexInterruptedError } from "../../src/application/index-interruption.ts";
import type { IndexLifecycle, IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import type { SessionIndexWriter } from "../../src/application/ports/session-index.ts";
import type {
  DiscoveredSession,
  SelectedSessionSource,
  SessionSource,
  SourceCaptureWorkspace,
} from "../../src/application/ports/session-source.ts";
import { runIndex } from "../../src/application/run-index.ts";
import { SourceFailureError } from "../../src/application/source-failure.ts";
import { createSessionListQuery } from "../../src/domain/session-query.ts";
import { formatSessionIdentity } from "../../src/domain/session-identity.ts";
import type { SessionDocument, SessionIdentity } from "../../src/domain/session.ts";
import { createSqliteIndexLifecycle } from "../../src/infrastructure/sqlite/database.ts";
import { readWriterLeaseHealth } from "../../src/infrastructure/sqlite/writer-lease.ts";
import { readWriterCleanProof } from "../../src/infrastructure/sqlite/writer-clean-proof.ts";
import { createFakeIndexingSource } from "../fixtures/indexing-source.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("runIndex with SQLite", () => {
  test("cleans staged changed reads before commit and skips staging for unchanged sessions", async () => {
    const paths = await fixturePaths();
    const lifecycle = createSqliteIndexLifecycle();
    const source = createFakeIndexingSource();
    const identity = sessionIdentity(source.instance, "session");
    const baseline = source.candidate("session", "revision-one");
    source.setDocument("session", document(identity, "last good"));
    source.setDiscovery([baseline]);
    let stagedFailure: SourceFailureError | undefined;
    let stagedReads = 0;
    let cleanedBeforeReadSettled = 0;
    const selected = withStagedReads(source.selected, async (workspace, read) => {
      stagedReads += 1;
      let attempt: string | undefined;
      try {
        const result = await workspace.withPrivateDirectory(async (directory) => {
          attempt = directory;
          await writeFile(path.join(directory, "capture.bin"), "generic staged input");
          if (stagedFailure !== undefined) throw stagedFailure;
          return read();
        });
        await requireMissing(attempt);
        cleanedBeforeReadSettled += 1;
        return result;
      } catch (error) {
        await requireMissing(attempt);
        cleanedBeforeReadSettled += 1;
        throw error;
      }
    });

    const first = await index(lifecycle, paths, selected);
    const unchanged = await index(lifecycle, paths, selected);

    expect(first.counts).toMatchObject({ discovered: 1, updated: 1, failed: 0 });
    expect(unchanged.counts).toMatchObject({ discovered: 1, unchanged: 1, failed: 0 });
    expect(stagedReads).toBe(1);
    expect(cleanedBeforeReadSettled).toBe(1);
    expect(source.readNativeIds).toEqual(["session"]);
    await requireMissing(paths.scratch);

    source.setDiscovery([source.candidate("session", "revision-two")]);
    source.setDocument("session", document(identity, "must not replace last good"));
    stagedFailure = new SourceFailureError({ kind: "malformed", source: source.instance });

    const failed = await index(lifecycle, paths, selected);

    expect(failed.counts).toMatchObject({ discovered: 1, updated: 0, failed: 1, stale: 1 });
    expect(stagedReads).toBe(2);
    expect(cleanedBeforeReadSettled).toBe(2);
    await requireMissing(paths.scratch);
    const reader = await lifecycle.openReader(paths);
    await expect(reader.sessions.getFreshness(identity)).resolves.toMatchObject({
      status: "stale",
      latest: { failure: "malformed" },
    });
    await expect(reader.sessions.getDocument(identity)).resolves.toMatchObject({
      title: "last good",
    });
    await reader.close();
  });

  test("indexes in binary order, collapses duplicates, and reindexes unchanged with zero reads", async () => {
    const paths = await fixturePaths();
    const lifecycle = createSqliteIndexLifecycle();
    const source = createFakeIndexingSource();
    const alpha = source.candidate("Alpha");
    const zeta = source.candidate("zeta");
    source.setDiscovery([zeta, alpha, source.candidate("zeta")]);

    const first = await runIndex({
      paths,
      sources: [source.selected],
      lifecycle,
      clock: clock(),
    });
    const readsAfterFirst = source.readNativeIds.length;
    source.setDiscovery([alpha, zeta]);
    const second = await runIndex({
      paths,
      sources: [source.selected],
      lifecycle,
      clock: clock(),
    });

    expect(first.counts).toEqual({
      discovered: 2,
      unchanged: 0,
      updated: 2,
      failed: 0,
      missing: 0,
      stale: 0,
    });
    expect(source.readNativeIds).toEqual(["Alpha", "zeta"]);
    expect(source.readNativeIds).toHaveLength(readsAfterFirst);
    expect(second.counts).toEqual({
      discovered: 2,
      unchanged: 2,
      updated: 0,
      failed: 0,
      missing: 0,
      stale: 0,
    });
  });

  test("refreshes on adapter-version changes and recovers stale state at the last-good revision", async () => {
    const paths = await fixturePaths();
    const lifecycle = createSqliteIndexLifecycle();
    const source = createFakeIndexingSource();
    const identity = sessionIdentity(source.instance, "session");
    source.setDocument("session", document(identity, "last good"));
    source.setDiscovery([source.candidate("session", "revision-one", "adapter-v1")]);
    await index(lifecycle, paths, source.selected);

    source.setDiscovery([source.candidate("session", "revision-one", "adapter-v2")]);
    const refreshed = await index(lifecycle, paths, source.selected);
    source.setDiscovery([source.candidate("session", "revision-two", "adapter-v2")]);
    source.failRead("session", "source-changed");
    const failed = await index(lifecycle, paths, source.selected);

    const staleReader = await lifecycle.openReader(paths);
    await expect(staleReader.sessions.getFreshness(identity)).resolves.toMatchObject({
      status: "stale",
    });
    await expect(staleReader.sessions.getDocument(identity)).resolves.toMatchObject({
      title: "last good",
    });
    await staleReader.close();

    const readsBeforeRecovery = source.readNativeIds.length;
    source.setDiscovery([source.candidate("session", "revision-one", "adapter-v2")]);
    const recovered = await index(lifecycle, paths, source.selected);

    expect(refreshed.counts.updated).toBe(1);
    expect(failed.counts).toMatchObject({ failed: 1, stale: 1, missing: 0 });
    expect(source.readNativeIds).toHaveLength(readsBeforeRecovery);
    expect(recovered.counts).toMatchObject({ unchanged: 1, failed: 0 });
    const currentReader = await lifecycle.openReader(paths);
    await expect(currentReader.sessions.getFreshness(identity)).resolves.toMatchObject({
      status: "current",
    });
    await currentReader.close();
  });

  test("recovers a first capture from one fresh discovery without persisting the transient failure", async () => {
    const paths = await fixturePaths();
    const lifecycle = createSqliteIndexLifecycle();
    const source = createFakeIndexingSource();
    const identity = sessionIdentity(source.instance, "session");
    const primary = source.candidate("session", "revision-primary");
    const fresh = source.candidate("session", "revision-fresh");
    source.setDocument("session", document(identity, "fresh capture"));
    source.queueDiscoveries({ candidates: [primary] }, { candidates: [fresh] });
    source.failNextRead("session", "source-changed");

    const report = await index(lifecycle, paths, source.selected);

    expect(report.sources[0]).toMatchObject({
      status: "completed",
      counts: {
        discovered: 1,
        unchanged: 0,
        updated: 1,
        failed: 0,
        missing: 0,
        stale: 0,
      },
      items: [],
      omittedItemCount: 0,
    });
    expect(source.probeCount).toBe(1);
    expect(source.discoveryWorkspaces).toHaveLength(2);
    expect(
      source.readCandidates.map(({ aggregateFingerprint }) => aggregateFingerprint.digest),
    ).toEqual([primary.aggregateFingerprint.digest, fresh.aggregateFingerprint.digest]);

    const reader = await lifecycle.openReader(paths);
    await expect(reader.sessions.getFreshness(identity)).resolves.toMatchObject({
      status: "current",
      lastGood: {
        aggregateFingerprint: fresh.aggregateFingerprint,
      },
      latest: { outcome: "indexed" },
    });
    await expect(reader.sessions.getDocument(identity)).resolves.toMatchObject({
      title: "fresh capture",
    });
    await reader.close();
    expect(readTrackingState(paths, identity)).toMatchObject({
      latest_fingerprint_digest: fresh.aggregateFingerprint.digest,
      latest_outcome: "indexed",
      latest_failure_code: null,
      presence_status: "present",
      has_document: 1,
    });
  });

  test("replaces an existing last-good snapshot after one fresh discovery", async () => {
    const paths = await fixturePaths();
    const lifecycle = createSqliteIndexLifecycle();
    const source = createFakeIndexingSource();
    const identity = sessionIdentity(source.instance, "session");
    const baseline = source.candidate("session", "revision-baseline");
    const runClock = clock();
    source.setDocument("session", document(identity, "old snapshot"));
    source.setDiscovery([baseline]);
    await runIndex({ paths, sources: [source.selected], lifecycle, clock: runClock });
    const baselineTracking = readTrackingState(paths, identity);

    const primary = source.candidate("session", "revision-primary");
    const fresh = source.candidate("session", "revision-fresh");
    source.setDocument("session", document(identity, "fresh snapshot"));
    source.queueDiscoveries({ candidates: [primary] }, { candidates: [fresh] });
    source.failNextRead("session", "source-changed");

    const report = await runIndex({
      paths,
      sources: [source.selected],
      lifecycle,
      clock: runClock,
    });

    expect(report.sources[0]).toMatchObject({
      status: "completed",
      counts: {
        discovered: 1,
        unchanged: 0,
        updated: 1,
        failed: 0,
        missing: 0,
        stale: 0,
      },
      items: [],
      omittedItemCount: 0,
    });
    expect(source.probeCount).toBe(2);
    expect(source.discoveryWorkspaces).toHaveLength(3);
    expect(
      source.readCandidates.map(({ aggregateFingerprint }) => aggregateFingerprint.digest),
    ).toEqual([
      baseline.aggregateFingerprint.digest,
      primary.aggregateFingerprint.digest,
      fresh.aggregateFingerprint.digest,
    ]);

    const reader = await lifecycle.openReader(paths);
    await expect(reader.sessions.getFreshness(identity)).resolves.toMatchObject({
      status: "current",
      lastGood: { aggregateFingerprint: fresh.aggregateFingerprint },
      latest: { outcome: "indexed" },
    });
    await expect(reader.sessions.getDocument(identity)).resolves.toMatchObject({
      title: "fresh snapshot",
    });
    await reader.close();
    const refreshedTracking = readTrackingState(paths, identity);
    expect(refreshedTracking).toMatchObject({
      latest_fingerprint_digest: fresh.aggregateFingerprint.digest,
      latest_outcome: "indexed",
      latest_failure_code: null,
      presence_status: "present",
      captured_at: expect.any(String),
      has_document: 1,
    });
    expect(refreshedTracking.captured_at).not.toBe(baselineTracking.captured_at);
  });

  test("records one terminal fresh source-change while preserving the last-good document", async () => {
    const paths = await fixturePaths();
    const lifecycle = createSqliteIndexLifecycle();
    const source = createFakeIndexingSource();
    const identity = sessionIdentity(source.instance, "session");
    const baseline = source.candidate("session", "revision-baseline");
    source.setDocument("session", document(identity, "last good"));
    source.setDiscovery([baseline]);
    await index(lifecycle, paths, source.selected);
    const baselineTracking = readTrackingState(paths, identity);

    const primary = source.candidate("session", "revision-primary");
    const fresh = source.candidate("session", "revision-fresh");
    source.queueDiscoveries({ candidates: [primary] }, { candidates: [fresh] });
    source.failRead("session", "source-changed");

    const report = await index(lifecycle, paths, source.selected);

    expect(report.sources[0]).toMatchObject({
      status: "completed",
      counts: {
        discovered: 1,
        unchanged: 0,
        updated: 0,
        failed: 1,
        missing: 0,
        stale: 1,
      },
      items: [
        {
          identity,
          outcome: "failed",
          failure: "source-changed",
        },
      ],
      omittedItemCount: 0,
    });
    expect(source.probeCount).toBe(2);
    expect(source.discoveryWorkspaces).toHaveLength(3);
    expect(
      source.readCandidates.map(({ aggregateFingerprint }) => aggregateFingerprint.digest),
    ).toEqual([
      baseline.aggregateFingerprint.digest,
      primary.aggregateFingerprint.digest,
      fresh.aggregateFingerprint.digest,
    ]);

    const reader = await lifecycle.openReader(paths);
    await expect(reader.sessions.getFreshness(identity)).resolves.toMatchObject({
      status: "stale",
      lastGood: { aggregateFingerprint: baseline.aggregateFingerprint },
      latest: {
        outcome: "failed",
        revision: { aggregateFingerprint: fresh.aggregateFingerprint },
        failure: "source-changed",
      },
    });
    await expect(reader.sessions.getDocument(identity)).resolves.toMatchObject({
      title: "last good",
    });
    await reader.close();
    expect(readTrackingState(paths, identity)).toMatchObject({
      latest_fingerprint_digest: fresh.aggregateFingerprint.digest,
      latest_outcome: "failed",
      latest_failure_code: "source-changed",
      presence_status: "present",
      captured_at: baselineTracking.captured_at,
      has_document: 1,
    });
  });

  test("reconciles a failed-first candidate as missing before a later successful read", async () => {
    const paths = await fixturePaths();
    const lifecycle = createSqliteIndexLifecycle();
    const source = createFakeIndexingSource();
    const candidate = source.candidate("session", "revision-one");
    const identity = sessionIdentity(source.instance, "session");
    source.setDiscovery([candidate]);
    source.failRead("session", "malformed");

    const failed = await index(lifecycle, paths, source.selected);
    const failedReader = await lifecycle.openReader(paths);
    await expect(failedReader.sessions.getFreshness(identity)).resolves.toMatchObject({
      status: "unindexed",
    });
    await expect(failedReader.sessions.getDocument(identity)).resolves.toBeUndefined();
    await failedReader.close();

    const failedTracking = readTrackingState(paths, identity);
    expect(failedTracking).toMatchObject({
      latest_adapter_version: "synthetic-v1",
      latest_outcome: "failed",
      latest_failure_code: "malformed",
      presence_status: "present",
      captured_at: null,
      has_document: 0,
    });

    source.setDiscovery([]);
    source.failDiscovery(new Error("private discovery failure"));
    const incomplete = await index(lifecycle, paths, source.selected);
    expect(incomplete.sources[0]).toMatchObject({
      status: "incomplete",
      failure: "discovery-failed",
      counts: { missing: 0 },
    });
    expect(readTrackingState(paths, identity)).toEqual(failedTracking);

    source.setDiscovery([]);
    const missing = await index(lifecycle, paths, source.selected);
    expect(missing.sources[0]).toMatchObject({
      status: "completed",
      counts: { discovered: 0, missing: 1 },
      items: [{ identity, outcome: "missing" }],
      omittedItemCount: 0,
    });
    const missingTracking = readTrackingState(paths, identity);
    expect(missingTracking).toMatchObject({
      latest_fingerprint_scheme: failedTracking.latest_fingerprint_scheme,
      latest_fingerprint_digest: failedTracking.latest_fingerprint_digest,
      latest_adapter_version: failedTracking.latest_adapter_version,
      latest_outcome: failedTracking.latest_outcome,
      latest_failure_code: failedTracking.latest_failure_code,
      presence_status: "missing",
      captured_at: null,
      has_document: 0,
    });
    const missingReader = await lifecycle.openReader(paths);
    await expect(missingReader.sessions.getFreshness(identity)).resolves.toMatchObject({
      status: "unindexed",
      latest: { failure: "malformed" },
    });
    await expect(missingReader.sessions.getDocument(identity)).resolves.toBeUndefined();
    await expect(missingReader.sessions.getSummary(identity)).resolves.toBeUndefined();
    await missingReader.close();

    source.clearReadFailure("session");
    source.setDiscovery([candidate]);
    const recovered = await index(lifecycle, paths, source.selected);

    expect(failed.counts).toMatchObject({ discovered: 1, failed: 1, stale: 0 });
    expect(recovered.counts).toMatchObject({ discovered: 1, updated: 1, failed: 0 });
    expect(source.readNativeIds).toEqual(["session", "session"]);
    const currentReader = await lifecycle.openReader(paths);
    await expect(currentReader.sessions.getFreshness(identity)).resolves.toMatchObject({
      status: "current",
    });
    await expect(currentReader.sessions.getDocument(identity)).resolves.toBeDefined();
    await currentReader.close();
    expect(readTrackingState(paths, identity)).toMatchObject({
      latest_outcome: "indexed",
      latest_failure_code: null,
      presence_status: "present",
      captured_at: expect.any(String),
      has_document: 1,
    });
  });

  test("retains and restores an unchanged revision after provider disappearance", async () => {
    const paths = await fixturePaths();
    const lifecycle = createSqliteIndexLifecycle();
    const source = createFakeIndexingSource();
    const candidate = source.candidate("session", "revision-one");
    const identity = sessionIdentity(source.instance, "session");
    source.setDiscovery([candidate]);
    await index(lifecycle, paths, source.selected);

    source.setDiscovery([]);
    const missing = await index(lifecycle, paths, source.selected);
    source.setDiscovery([candidate]);
    const restored = await index(lifecycle, paths, source.selected);

    expect(missing.sources[0]).toMatchObject({
      counts: { missing: 1 },
      items: [{ identity, outcome: "missing" }],
      omittedItemCount: 0,
    });
    expect(restored.counts).toMatchObject({ discovered: 1, updated: 0, unchanged: 1 });
    expect(source.readNativeIds).toEqual(["session"]);
    const reader = await lifecycle.openReader(paths);
    await expect(reader.sessions.getDocument(identity)).resolves.toBeDefined();
    await reader.close();
  });

  test("keeps canonical content through invalid and complete missing scans", async () => {
    const paths = await fixturePaths();
    const lifecycle = createSqliteIndexLifecycle();
    const source = createFakeIndexingSource();
    const baseline = source.candidate("session", "revision-one");
    const identity = sessionIdentity(source.instance, "session");
    source.setDocument("session", document(identity, "retained evidence"));
    source.setDiscovery([baseline]);
    await index(lifecycle, paths, source.selected);
    const readsAfterBaseline = source.readNativeIds.length;

    const other = createFakeIndexingSource({
      kind: source.instance.kind,
      instanceId: "other",
    });
    const invalidScans: readonly (readonly DiscoveredSession[])[] = [
      [baseline, source.candidate("session", "conflicting-revision")],
      [{} as DiscoveredSession],
      [other.candidate("wrong-source")],
    ];
    for (const candidates of invalidScans) {
      source.setDiscovery(candidates);
      const report = await index(lifecycle, paths, source.selected);
      expect(report.sources[0]).toMatchObject({
        status: "incomplete",
        failure: "discovery-failed",
        counts: {
          discovered: 0,
          unchanged: 0,
          updated: 0,
          failed: 0,
          missing: 0,
          stale: 0,
        },
      });
      expect(source.readNativeIds).toHaveLength(readsAfterBaseline);
      const reader = await lifecycle.openReader(paths);
      await expect(reader.sessions.getDocument(identity)).resolves.toMatchObject({
        title: "retained evidence",
      });
      await reader.close();
    }

    source.setDiscovery([]);
    const missing = await index(lifecycle, paths, source.selected);
    expect(missing.counts.missing).toBe(1);
    const reader = await lifecycle.openReader(paths);
    await expect(reader.sessions.getDocument(identity)).resolves.toMatchObject({
      title: "retained evidence",
    });
    await expect(reader.sessions.getSummary(identity)).resolves.toMatchObject({
      sourceState: "missing",
    });
    await reader.close();
  });

  test("isolates arbitrary source kinds with colliding native IDs", async () => {
    const paths = await fixturePaths();
    const lifecycle = createSqliteIndexLifecycle();
    const alpha = createFakeIndexingSource({ kind: "alpha-source", instanceId: "one" });
    const beta = createFakeIndexingSource({ kind: "beta-source", instanceId: "one" });
    alpha.setDiscovery([alpha.candidate("shared")]);
    beta.setDiscovery([beta.candidate("shared")]);

    const report = await runIndex({
      paths,
      sources: [beta.selected, alpha.selected],
      lifecycle,
      clock: clock(),
    });

    expect(report.sources.map(({ source }) => source)).toEqual([alpha.instance, beta.instance]);
    const reader = await lifecycle.openReader(paths);
    await expect(
      reader.sessions.getDocument(sessionIdentity(alpha.instance, "shared")),
    ).resolves.toBeDefined();
    await expect(
      reader.sessions.getDocument(sessionIdentity(beta.instance, "shared")),
    ).resolves.toBeDefined();
    await reader.close();
  });

  test("reconciles missing state only within the exact source instance", async () => {
    const paths = await fixturePaths();
    const lifecycle = createSqliteIndexLifecycle();
    const first = createFakeIndexingSource({ kind: "synthetic", instanceId: "first" });
    const second = createFakeIndexingSource({ kind: "synthetic", instanceId: "second" });
    const firstIdentity = sessionIdentity(first.instance, "shared");
    const secondIdentity = sessionIdentity(second.instance, "shared");
    first.setDiscovery([first.candidate("shared")]);
    second.setDiscovery([second.candidate("shared")]);
    await runIndex({
      paths,
      sources: [first.selected, second.selected],
      lifecycle,
      clock: clock(),
    });

    first.setDiscovery([]);
    const report = await index(lifecycle, paths, first.selected);

    expect(report.sources[0]).toMatchObject({
      counts: { missing: 1 },
      items: [{ identity: firstIdentity, outcome: "missing" }],
    });
    const reader = await lifecycle.openReader(paths);
    await expect(reader.sessions.getDocument(firstIdentity)).resolves.toBeDefined();
    await expect(reader.sessions.getDocument(secondIdentity)).resolves.toBeDefined();
    await reader.close();
  });

  test("preserves exact mixed state across freshness and reconciliation batch boundaries", async () => {
    const paths = await fixturePaths();
    const lifecycle = createSqliteIndexLifecycle();
    const source = createFakeIndexingSource();
    const nativeIds = Array.from(
      { length: 259 },
      (_, index) => `session-${String(index).padStart(3, "0")}`,
    );
    const baseline = new Map(
      nativeIds.map((nativeId) => [nativeId, source.candidate(nativeId, "baseline")]),
    );
    const retainedMissing = "session-000";
    const changed = ["session-127", "session-128"] as const;
    const failed = ["session-129", "session-257"] as const;
    const retainedMissingTail = "session-258";

    source.setDocument(
      retainedMissing,
      document(sessionIdentity(source.instance, retainedMissing), "retained missing head"),
    );
    source.setDocument(
      retainedMissingTail,
      document(sessionIdentity(source.instance, retainedMissingTail), "retained missing tail"),
    );
    for (const nativeId of failed) {
      source.setDocument(
        nativeId,
        document(sessionIdentity(source.instance, nativeId), `retained ${nativeId}`),
      );
    }
    source.setDiscovery(nativeIds.map((nativeId) => requireCandidate(baseline, nativeId)));
    const seeded = await index(lifecycle, paths, source.selected);
    expect(seeded.counts).toEqual({
      discovered: 259,
      unchanged: 0,
      updated: 259,
      failed: 0,
      missing: 0,
      stale: 0,
    });
    const readsAfterSeed = source.readNativeIds.length;

    const omitted = new Set([retainedMissing, retainedMissingTail]);
    source.setDiscovery(
      nativeIds
        .filter((nativeId) => !omitted.has(nativeId))
        .map((nativeId) =>
          changed.includes(nativeId as (typeof changed)[number]) ||
          failed.includes(nativeId as (typeof failed)[number])
            ? source.candidate(nativeId, "changed")
            : requireCandidate(baseline, nativeId),
        ),
    );
    for (const nativeId of changed) {
      source.setDocument(
        nativeId,
        document(sessionIdentity(source.instance, nativeId), `changed ${nativeId}`),
      );
    }
    for (const nativeId of failed) source.failRead(nativeId, "malformed");

    const report = await index(lifecycle, paths, source.selected);

    const expectedCounts = {
      discovered: 257,
      unchanged: 253,
      updated: 2,
      failed: 2,
      missing: 2,
      stale: 2,
    } as const;
    expect(report).toEqual({
      schemaVersion: 1,
      command: "index",
      startedAt: "2026-07-13T12:00:00.000Z",
      finishedAt: "2026-07-13T12:00:03.000Z",
      counts: expectedCounts,
      sources: [
        {
          schemaVersion: 1,
          source: source.instance,
          status: "completed",
          startedAt: "2026-07-13T12:00:01.000Z",
          finishedAt: "2026-07-13T12:00:02.000Z",
          counts: expectedCounts,
          coverage: { status: "complete", observedAt: "2026-07-13T12:00:01.000Z" },
          items: [
            {
              identity: reportIdentity(sessionIdentity(source.instance, failed[0])),
              outcome: "failed",
              failure: "malformed",
            },
            {
              identity: reportIdentity(sessionIdentity(source.instance, failed[1])),
              outcome: "failed",
              failure: "malformed",
            },
            {
              identity: reportIdentity(sessionIdentity(source.instance, retainedMissing)),
              outcome: "missing",
            },
            {
              identity: reportIdentity(sessionIdentity(source.instance, retainedMissingTail)),
              outcome: "missing",
            },
          ],
          omittedItemCount: 0,
        },
      ],
      incompleteSources: 0,
      skippedSources: 0,
      omittedItemCount: 0,
    });
    expect(source.readNativeIds.slice(readsAfterSeed)).toEqual([...changed, ...failed].sort());
    expect(readLatestRunItems(paths)).toEqual([
      { native_id: failed[0], outcome: "failed", failure_code: "malformed" },
      { native_id: failed[1], outcome: "failed", failure_code: "malformed" },
      { native_id: retainedMissing, outcome: "missing", failure_code: null },
      { native_id: retainedMissingTail, outcome: "missing", failure_code: null },
    ]);

    const reader = await lifecycle.openReader(paths);
    await expect(
      reader.sessions.getDocument(sessionIdentity(source.instance, changed[0])),
    ).resolves.toMatchObject({ title: `changed ${changed[0]}` });
    await expect(
      reader.sessions.getDocument(sessionIdentity(source.instance, failed[0])),
    ).resolves.toMatchObject({ title: `retained ${failed[0]}` });
    await expect(
      reader.sessions.getSummary(sessionIdentity(source.instance, failed[0])),
    ).resolves.toMatchObject({ freshness: "stale", sourceState: "present" });
    await expect(
      reader.sessions.getDocument(sessionIdentity(source.instance, retainedMissing)),
    ).resolves.toMatchObject({ title: "retained missing head" });
    await expect(
      reader.sessions.getSummary(sessionIdentity(source.instance, retainedMissing)),
    ).resolves.toMatchObject({ freshness: "current", sourceState: "missing" });
    await expect(
      reader.query.list(createSessionListQuery({ filter: { sourceState: "missing" }, limit: 10 })),
    ).resolves.toMatchObject({
      sessions: [
        { identity: sessionIdentity(source.instance, retainedMissing) },
        { identity: sessionIdentity(source.instance, retainedMissingTail) },
      ],
      captureScope: { status: "complete" },
    });
    await reader.close();

    await expect(lifecycle.inspectHealth(paths)).resolves.toMatchObject({
      ok: true,
      captureScope: {
        status: "incomplete",
        trackedSessions: 259,
        retainedSessions: { current: 257, stale: 2 },
        unindexedSessions: 0,
        sourceState: { present: 257, missing: 2, unknown: 0 },
        sourceCoverage: { complete: 1, unknown: 0 },
        latestFailures: {
          unavailable: 0,
          unreadable: 0,
          malformed: 2,
          sourceChanged: 0,
          unsupportedFormat: 0,
          repositoryWrite: 0,
        },
      },
      canonicalIntegrity: "ok",
      runRecords: "ok",
      writerLease: "free",
      activeRuns: 0,
    });
    await expect(readWriterCleanProof(paths.database)).resolves.toBeDefined();
  });

  test("cooperative cancellation preserves committed and untouched last-good documents", async () => {
    const paths = await fixturePaths();
    const lifecycle = createSqliteIndexLifecycle();
    const source = createFakeIndexingSource();
    const alpha = sessionIdentity(source.instance, "alpha");
    const zeta = sessionIdentity(source.instance, "zeta");
    source.setDiscovery([
      source.candidate("alpha", "baseline-alpha"),
      source.candidate("zeta", "baseline-zeta"),
    ]);
    source.setDocument("alpha", document(alpha, "old alpha"));
    source.setDocument("zeta", document(zeta, "old zeta"));
    await index(lifecycle, paths, source.selected);

    source.setDiscovery([
      source.candidate("alpha", "changed-alpha"),
      source.candidate("zeta", "changed-zeta"),
    ]);
    source.setDocument("alpha", document(alpha, "new alpha"));
    source.setDocument("zeta", document(zeta, "new zeta must not commit"));
    const controller = new AbortController();
    const cancellingLifecycle = cancelAfterFirstReplacement(lifecycle, controller);

    await expect(
      runIndex({
        paths,
        sources: [source.selected],
        lifecycle: cancellingLifecycle,
        clock: clock(),
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(IndexInterruptedError);

    const reader = await lifecycle.openReader(paths);
    await expect(reader.sessions.getDocument(alpha)).resolves.toMatchObject({ title: "new alpha" });
    await expect(reader.sessions.getDocument(zeta)).resolves.toMatchObject({ title: "old zeta" });
    await reader.close();

    const state = readCancellationState(paths);
    expect(state.run).toMatchObject({
      status: "interrupted",
      failure_code: "interrupted",
      discovered_count: 1,
      updated_count: 1,
      missing_count: 0,
    });
    expect(state.source).toMatchObject({ coverage_status: "unknown" });
    expect(state.zeta).toMatchObject({
      latest_fingerprint_digest: source.candidate("zeta", "baseline-zeta").aggregateFingerprint
        .digest,
      presence_status: "present",
    });
    expect(state.lease).toMatchObject({
      purpose: null,
      clean_generation: state.lease.generation,
    });
    expect(readWriterLeaseHealth(state.database, { now: () => new Date() })).toEqual({
      status: "free",
      generation: state.lease.generation,
    });
    state.database.close();
    await expect(readWriterCleanProof(paths.database)).resolves.toMatchObject({
      writerGeneration: state.lease.generation,
    });
  });

  test("cleanup failure after cancellation suppresses the clean proof and next fast open", async () => {
    const paths = await fixturePaths();
    const lifecycle = createSqliteIndexLifecycle();
    const source = createFakeIndexingSource();
    source.setDiscovery([source.candidate("session")]);
    const controller = new AbortController();
    const cancellingLifecycle = cancelAfterFirstReplacement(lifecycle, controller, async () => {
      await rm(paths.scratch, { force: true, recursive: true });
      await writeFile(paths.scratch, "unsafe scratch replacement");
    });

    const error = await runIndex({
      paths,
      sources: [source.selected],
      lifecycle: cancellingLifecycle,
      clock: clock(),
      signal: controller.signal,
    }).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[0]).toBeInstanceOf(IndexInterruptedError);
    await expect(readWriterCleanProof(paths.database)).resolves.toBeUndefined();

    await rm(paths.scratch, { force: true });
    const modes: string[] = [];
    const writer = await lifecycle.openWriter(paths, {
      progress(event) {
        if (event.kind === "writer-open-mode") modes.push(event.mode);
      },
    });
    await writer.close();
    expect(modes).toEqual(["full-validation"]);
  });
});

function cancelAfterFirstReplacement(
  lifecycle: ReturnType<typeof createSqliteIndexLifecycle>,
  controller: AbortController,
  afterReplacement?: () => Promise<void>,
): IndexLifecycle {
  return {
    inspect: (paths) => lifecycle.inspect(paths),
    inspectHealth: (paths) => lifecycle.inspectHealth(paths),
    openReader: (paths) => lifecycle.openReader(paths),
    async openWriter(paths, options) {
      const writer = await lifecycle.openWriter(paths, options);
      let replacements = 0;
      const sessions = new Proxy(writer.sessions, {
        get(target, property) {
          if (property === "replaceSession") {
            return async (...args: Parameters<SessionIndexWriter["replaceSession"]>) => {
              const result = await target.replaceSession(...args);
              replacements += 1;
              if (replacements === 1) {
                await afterReplacement?.();
                controller.abort();
              }
              return result;
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return {
        state: writer.state,
        sessions,
        workspace: writer.workspace,
        close: () => writer.close(),
      };
    },
  };
}

async function index(
  lifecycle: ReturnType<typeof createSqliteIndexLifecycle>,
  paths: IndexPaths,
  source: ReturnType<typeof createFakeIndexingSource>["selected"],
) {
  return runIndex({ paths, sources: [source], lifecycle, clock: clock() });
}

function withStagedReads(
  selected: SelectedSessionSource,
  stage: (
    workspace: SourceCaptureWorkspace,
    read: () => Promise<SessionDocument>,
  ) => Promise<SessionDocument>,
): SelectedSessionSource {
  const adapter: SessionSource = {
    kind: selected.adapter.kind,
    probe: () => selected.adapter.probe(),
    discover: (workspace) => selected.adapter.discover(workspace),
    read: (candidate, workspace) =>
      stage(workspace, () => selected.adapter.read(candidate, workspace)),
  };
  return { instance: selected.instance, adapter };
}

async function requireMissing(target: string | undefined): Promise<void> {
  if (target === undefined) throw new Error("Expected a staged capture path");
  try {
    await lstat(target);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  throw new Error("Staged capture residue remains");
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function fixturePaths(): Promise<IndexPaths> {
  const root = await mkdtemp(path.join(tmpdir(), "sessions-run-index-"));
  temporaryDirectories.push(root);
  const directory = path.join(root, "cache");
  const database = path.join(directory, "sessions.sqlite3");
  return {
    directory,
    scratch: path.join(directory, ".scratch"),
    database,
    wal: `${database}-wal`,
    shm: `${database}-shm`,
  };
}

function clock() {
  let milliseconds = Date.parse("2026-07-13T12:00:00.000Z");
  return {
    now() {
      const result = new Date(milliseconds);
      milliseconds += 1_000;
      return result;
    },
  };
}

function sessionIdentity(
  source: ReturnType<typeof createFakeIndexingSource>["instance"],
  nativeId: string,
): SessionIdentity {
  return { source, nativeId };
}

function reportIdentity(identity: SessionIdentity) {
  return { canonicalId: formatSessionIdentity(identity), ...identity };
}

function document(identity: SessionIdentity, title: string): SessionDocument {
  return { identity, title, lineageCoverage: "unknown", relations: [], entries: [] };
}

function readTrackingState(paths: IndexPaths, identity: SessionIdentity): Record<string, unknown> {
  const url = pathToFileURL(paths.database);
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");
  const database = new DatabaseSync(url.href, { readOnly: true });
  try {
    const row = database
      .prepare(
        `SELECT tracking.latest_fingerprint_scheme,
                tracking.latest_fingerprint_digest,
                tracking.latest_adapter_version,
                tracking.latest_outcome,
                tracking.latest_failure_code,
                tracking.presence_status,
                tracking.presence_observed_at,
                tracking.captured_at,
                EXISTS (
                  SELECT 1
                  FROM sessions_canonical_sessions AS canonical
                  WHERE canonical.session_id = tracking.session_id
                ) AS has_document
         FROM sessions_session_tracking AS tracking
         JOIN sessions_source_instances AS source
           ON source.source_instance_id = tracking.source_instance_id
         WHERE source.kind = ?
           AND source.instance_id = ?
           AND tracking.native_id = ?`,
      )
      .get(identity.source.kind, identity.source.instanceId, identity.nativeId) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) throw new Error("Expected tracked session state");
    return row;
  } finally {
    database.close();
  }
}

function requireCandidate(
  candidates: ReadonlyMap<string, DiscoveredSession>,
  nativeId: string,
): DiscoveredSession {
  const candidate = candidates.get(nativeId);
  if (candidate === undefined) throw new Error(`Expected candidate ${nativeId}`);
  return candidate;
}

function readLatestRunItems(paths: IndexPaths): readonly Record<string, unknown>[] {
  const url = pathToFileURL(paths.database);
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");
  const database = new DatabaseSync(url.href, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT tracking.native_id, item.outcome, item.failure_code
         FROM sessions_index_run_items AS item
         JOIN sessions_session_tracking AS tracking
           ON tracking.session_id = item.session_id
         WHERE item.run_id = (SELECT MAX(run_id) FROM sessions_index_runs)
         ORDER BY item.ordinal`,
      )
      .all() as unknown as readonly Record<string, unknown>[];
  } finally {
    database.close();
  }
}

function readCancellationState(paths: IndexPaths): {
  readonly database: DatabaseSync;
  readonly run: Record<string, unknown>;
  readonly source: Record<string, unknown>;
  readonly zeta: Record<string, unknown>;
  readonly lease: {
    readonly generation: number;
    readonly clean_generation: number | null;
    readonly purpose: string | null;
  };
} {
  const database = new DatabaseSync(paths.database, { readOnly: true });
  const run = database
    .prepare(
      `SELECT status,
              failure_code,
              discovered_count,
              indexed_count AS updated_count,
              missing_count
       FROM sessions_index_runs
       ORDER BY run_id DESC
       LIMIT 1`,
    )
    .get() as Record<string, unknown>;
  const source = database
    .prepare(
      `SELECT coverage_status, coverage_observed_at
       FROM sessions_source_instances
       WHERE kind = 'synthetic' AND instance_id = 'default'`,
    )
    .get() as Record<string, unknown>;
  const zeta = database
    .prepare(
      `SELECT tracking.latest_fingerprint_digest, tracking.presence_status
       FROM sessions_session_tracking AS tracking
       JOIN sessions_source_instances AS source
         ON source.source_instance_id = tracking.source_instance_id
       WHERE source.kind = 'synthetic'
         AND source.instance_id = 'default'
         AND tracking.native_id = 'zeta'`,
    )
    .get() as Record<string, unknown>;
  const lease = database.prepare("SELECT * FROM sessions_writer_lease").get() as {
    readonly generation: number;
    readonly clean_generation: number | null;
    readonly purpose: string | null;
  };
  return { database, run, source, zeta, lease };
}
