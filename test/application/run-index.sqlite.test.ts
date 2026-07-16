import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import type { IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import type { DiscoveredSession } from "../../src/application/ports/session-source.ts";
import { runIndex } from "../../src/application/run-index.ts";
import type { SessionDocument, SessionIdentity } from "../../src/domain/session.ts";
import { createSqliteIndexLifecycle } from "../../src/infrastructure/sqlite/database.ts";
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
});

async function index(
  lifecycle: ReturnType<typeof createSqliteIndexLifecycle>,
  paths: IndexPaths,
  source: ReturnType<typeof createFakeIndexingSource>["selected"],
) {
  return runIndex({ paths, sources: [source], lifecycle, clock: clock() });
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
