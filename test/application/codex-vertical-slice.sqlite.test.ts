import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, readlink, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import { clearData } from "../../src/application/clear-index.ts";
import { forgetSession } from "../../src/application/forget-session.ts";
import { listSessions } from "../../src/application/list-sessions.ts";
import type { IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import { runIndex } from "../../src/application/run-index.ts";
import { showSession } from "../../src/application/show-session.ts";
import { createCodexSource } from "../../src/adapters/codex/source.ts";
import type { SessionIdentity } from "../../src/domain/session.ts";
import { createSqliteIndexLifecycle } from "../../src/infrastructure/sqlite/database.ts";
import { createSqliteIndexMaintenance } from "../../src/infrastructure/sqlite/index-maintenance.ts";
import {
  codexRolloutRecords,
  createCodexSourceFixture,
  type CodexFixtureThread,
  type CodexSourceFixture,
} from "../fixtures/codex/source.ts";

const TARGET_ID = "target-thread";
const CHILD_ID = "child-thread";
const TARGET_ROLLOUT = "sessions/rollout-2026-target-thread.jsonl";
const CHILD_ROLLOUT = "sessions/rollout-2026-child-thread.jsonl";
const PARENT_ID = "external-parent";

let fixture: CodexSourceFixture | undefined;

afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
});

describe("Codex durable vertical slice", () => {
  test("retains, forgets, recaptures, and clears synthetic Codex sessions end to end", async () => {
    fixture = await createCodexSourceFixture();
    const paths = indexPaths(fixture.root);
    const leaseNow = monotonicNow("2026-07-14T12:00:00.000Z", 100);
    const lifecycle = createSqliteIndexLifecycle({
      now: leaseNow,
      writerToken: tokenFactory("index"),
    });
    const maintenance = createSqliteIndexMaintenance({
      now: leaseNow,
      token: tokenFactory("maintenance"),
    });
    const indexClock = { now: monotonicNow("2026-07-14T13:00:00.000Z", 1_000) };

    await fixture.writeRollout(
      TARGET_ROLLOUT,
      codexRolloutRecords(TARGET_ID, "Shared synthetic evidence", PARENT_ID),
    );
    await fixture.writeRollout(
      CHILD_ROLLOUT,
      codexRolloutRecords(CHILD_ID, "Shared synthetic evidence", TARGET_ID),
    );
    fixture.writeState(providerThreads(), providerEdges());

    const selected = await withoutProviderMutation(fixture.codexHome, () =>
      createCodexSource(fixture!.environment),
    );
    const targetIdentity = identity(selected.instance, TARGET_ID);
    const childIdentity = identity(selected.instance, CHILD_ID);
    const index = () =>
      withoutProviderMutation(fixture!.codexHome, () =>
        runIndex({ paths, sources: [selected], lifecycle, clock: indexClock }),
      );
    const list = () =>
      withoutProviderMutation(fixture!.codexHome, () => listSessions({ paths, lifecycle }));
    const show = (value: SessionIdentity) =>
      withoutProviderMutation(fixture!.codexHome, () =>
        showSession({ paths, lifecycle, identity: value }),
      );
    const forget = () =>
      withoutProviderMutation(fixture!.codexHome, () =>
        forgetSession(paths, maintenance, targetIdentity),
      );

    const first = await index();
    expect(first).toMatchObject({
      counts: { discovered: 2, unchanged: 0, updated: 2, failed: 0, missing: 0, stale: 0 },
      incompleteSources: 0,
    });
    await expectNoProviderRootInLibrary(paths, fixture.codexHome);
    const initialList = await list();
    expect(initialList.sessions).toHaveLength(2);
    expect(summary(initialList.sessions, TARGET_ID)).toMatchObject({
      identity: targetIdentity,
      freshness: "current",
      sourceState: "present",
    });
    const beforeAdapterUpgrade = await show(targetIdentity);
    expect(beforeAdapterUpgrade.entries).toHaveLength(1);

    // A retained V1 observation is normalized again under V2, then stabilizes.
    setStoredAdapterVersion(paths.database, "codex-v1");
    expect(storedAdapterVersions(paths.database)).toEqual(["codex-v1"]);
    const adapterUpgrade = await index();
    expect(adapterUpgrade.counts).toMatchObject({
      discovered: 2,
      unchanged: 0,
      updated: 2,
      failed: 0,
    });
    expect(storedAdapterVersions(paths.database)).toEqual(["codex-v2"]);
    const adapterStable = await index();
    expect(adapterStable.counts).toMatchObject({
      discovered: 2,
      unchanged: 2,
      updated: 0,
      failed: 0,
    });
    const initialTarget = await show(targetIdentity);
    expect(initialTarget.entries).toEqual(beforeAdapterUpgrade.entries);
    const initialCapture = initialTarget.summary.capturedAt;

    // A complete scan missing only the target retains its last-good document.
    fixture.writeState(providerThreads(false), providerEdges());
    const missing = await index();
    expect(missing).toMatchObject({
      counts: { discovered: 1, unchanged: 1, updated: 0, failed: 0, missing: 1, stale: 0 },
      sources: [{ status: "completed", coverage: { status: "complete" } }],
    });
    const retainedTarget = await show(targetIdentity);
    expect(retainedTarget.summary).toMatchObject({
      freshness: "current",
      sourceState: "missing",
      capturedAt: initialCapture,
    });
    expect(retainedTarget.entries).toEqual(initialTarget.entries);

    const missingAgain = await index();
    expect(missingAgain.counts).toMatchObject({
      discovered: 1,
      unchanged: 1,
      updated: 0,
      missing: 1,
    });
    const retainedAgain = await show(targetIdentity);
    expect(retainedAgain.entries).toEqual(initialTarget.entries);
    expect((await list()).sessions).toHaveLength(2);

    // An identical restored row is present again without recapturing content.
    fixture.writeState(providerThreads(), providerEdges());
    const restored = await index();
    expect(restored.counts).toMatchObject({ discovered: 2, unchanged: 2, updated: 0, missing: 0 });
    const restoredTarget = await show(targetIdentity);
    expect(restoredTarget.summary).toMatchObject({
      freshness: "current",
      sourceState: "present",
      capturedAt: initialCapture,
    });
    expect(restoredTarget.entries).toEqual(initialTarget.entries);

    await fixture.writeRollout(
      TARGET_ROLLOUT,
      codexRolloutRecords(TARGET_ID, "Changed synthetic evidence", PARENT_ID),
    );
    fixture.writeState(providerThreads(true, "Target v2", 4_000), providerEdges());
    const changed = await index();
    expect(changed.counts).toMatchObject({ discovered: 2, unchanged: 1, updated: 1, failed: 0 });
    const changedTarget = await show(targetIdentity);
    expect(changedTarget.summary).toMatchObject({
      title: "Target v2",
      freshness: "current",
      sourceState: "present",
    });
    expect(changedTarget.summary.capturedAt).not.toBe(initialCapture);
    expect(changedTarget.entries).not.toEqual(initialTarget.entries);

    // An unavailable source yields unknown coverage and cannot mark retained rows missing.
    const unavailableState = `${fixture.stateDatabase}.unavailable`;
    await rename(fixture.stateDatabase, unavailableState);
    const unknown = await index();
    expect(unknown).toMatchObject({
      counts: { discovered: 0, unchanged: 0, updated: 0, failed: 0, missing: 0, stale: 0 },
      incompleteSources: 1,
      sources: [
        {
          status: "incomplete",
          failure: "source-unavailable",
          coverage: { status: "unknown" },
        },
      ],
    });
    const unknownList = await list();
    expect(summary(unknownList.sessions, TARGET_ID).sourceState).toBe("unknown");
    expect(summary(unknownList.sessions, CHILD_ID).sourceState).toBe("unknown");
    const unknownTarget = await show(targetIdentity);
    expect(unknownTarget.entries).toEqual(changedTarget.entries);
    await rename(unavailableState, fixture.stateDatabase);

    // A discovered malformed rollout is present but stale at the last-good snapshot.
    await fixture.writeRollout(TARGET_ROLLOUT, "not-json\n");
    const stale = await index();
    expect(stale).toMatchObject({
      counts: { discovered: 2, unchanged: 1, updated: 0, failed: 1, missing: 0, stale: 1 },
      sources: [{ status: "completed", coverage: { status: "complete" } }],
    });
    const staleTarget = await show(targetIdentity);
    expect(staleTarget.summary).toMatchObject({ freshness: "stale", sourceState: "present" });
    expect(staleTarget.entries).toEqual(changedTarget.entries);

    await fixture.writeRollout(
      TARGET_ROLLOUT,
      codexRolloutRecords(TARGET_ID, "Recovered synthetic evidence", PARENT_ID),
    );
    const recovered = await index();
    expect(recovered.counts).toMatchObject({ discovered: 2, unchanged: 1, updated: 1, failed: 0 });
    const recoveredTarget = await show(targetIdentity);
    expect(recoveredTarget.summary).toMatchObject({ freshness: "current", sourceState: "present" });
    expect(recoveredTarget.entries).not.toEqual(changedTarget.entries);

    const forgotten = await forget();
    expect(forgotten.outcome).toBe("forgotten");
    await expect(show(targetIdentity)).rejects.toMatchObject({ code: "session-not-found" });
    const afterForget = await list();
    expect(afterForget.sessions.map(({ identity: value }) => value)).toEqual([childIdentity]);

    await expect(forget()).resolves.toMatchObject({ outcome: "absent" });
    expect((await list()).sessions).toHaveLength(1);

    const recaptured = await index();
    expect(recaptured.counts).toMatchObject({
      discovered: 2,
      unchanged: 1,
      updated: 1,
      failed: 0,
      missing: 0,
    });
    const recapturedTarget = await show(targetIdentity);
    expect(recapturedTarget.entries).toEqual(recoveredTarget.entries);
    expect((await list()).sessions).toHaveLength(2);

    const neighbor = path.join(paths.directory, "keep.txt");
    await mkdir(paths.scratch, { mode: 0o700, recursive: true });
    await writeFile(path.join(paths.scratch, "temporary.txt"), "owned scratch", { mode: 0o600 });
    await writeFile(neighbor, "unrelated library neighbor", { mode: 0o600 });
    const cleared = await withoutProviderMutation(fixture.codexHome, () =>
      clearData(paths, maintenance),
    );
    expect(cleared).toMatchObject({
      outcome: "cleared",
      scratchRemoved: true,
      databaseRemoved: true,
    });
    expect(existsSync(paths.database)).toBe(false);
    expect(existsSync(paths.wal)).toBe(false);
    expect(existsSync(paths.shm)).toBe(false);
    expect(existsSync(paths.scratch)).toBe(false);
    await expect(readFile(neighbor, "utf8")).resolves.toBe("unrelated library neighbor");
    await expect(list()).resolves.toEqual({ sessions: [] });
  });
});

function providerThreads(
  includeTarget = true,
  targetTitle = "Target v1",
  targetUpdatedAtMs = 2_000,
): readonly CodexFixtureThread[] {
  const target: CodexFixtureThread = {
    id: TARGET_ID,
    rolloutPath: TARGET_ROLLOUT,
    title: targetTitle,
    workspace: "/synthetic/workspace",
    createdAtMs: 1_000,
    updatedAtMs: targetUpdatedAtMs,
  };
  const child: CodexFixtureThread = {
    id: CHILD_ID,
    rolloutPath: CHILD_ROLLOUT,
    title: "Child",
    workspace: "/synthetic/workspace",
    createdAtMs: 1_500,
    updatedAtMs: 2_500,
  };
  return includeTarget ? [target, child] : [child];
}

function providerEdges() {
  return [
    { parentId: PARENT_ID, childId: TARGET_ID, status: "ready" },
    { parentId: TARGET_ID, childId: CHILD_ID, status: "ready" },
  ] as const;
}

function identity(source: SessionIdentity["source"], nativeId: string): SessionIdentity {
  return { source, nativeId };
}

function indexPaths(root: string): IndexPaths {
  const directory = path.join(root, "library");
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

function setStoredAdapterVersion(databaseFile: string, version: "codex-v1"): void {
  const database = new DatabaseSync(databaseFile);
  try {
    const result = database
      .prepare(
        `UPDATE sessions_session_tracking
         SET last_good_adapter_version = ?, latest_adapter_version = ?
         WHERE last_good_adapter_version IS NOT NULL`,
      )
      .run(version, version);
    expect(result.changes).toBe(2);
  } finally {
    database.close();
  }
}

function storedAdapterVersions(databaseFile: string): readonly string[] {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const rows = database
      .prepare(
        `SELECT DISTINCT last_good_adapter_version AS version
         FROM sessions_session_tracking
         WHERE last_good_adapter_version IS NOT NULL
         ORDER BY version`,
      )
      .all() as unknown as readonly { readonly version: string }[];
    return rows.map(({ version }) => version);
  } finally {
    database.close();
  }
}

function summary<
  T extends {
    readonly identity: SessionIdentity;
    readonly sourceState: "present" | "missing" | "unknown";
  },
>(summaries: readonly T[], nativeId: string): T {
  const result = summaries.find(({ identity: value }) => value.nativeId === nativeId);
  if (result === undefined) throw new Error(`Missing synthetic summary: ${nativeId}`);
  return result;
}

async function withoutProviderMutation<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const before = await snapshotProviderTree(root);
  try {
    return await operation();
  } finally {
    expect(await snapshotProviderTree(root)).toEqual(before);
  }
}

async function expectNoProviderRootInLibrary(
  paths: IndexPaths,
  providerRoot: string,
): Promise<void> {
  const needle = Buffer.from(providerRoot);
  for (const file of [paths.database, paths.wal, paths.shm]) {
    if (!existsSync(file)) continue;
    expect((await readFile(file)).indexOf(needle)).toBe(-1);
  }
}

interface ProviderNodeSnapshot {
  readonly type: "directory" | "file" | "symlink" | "other";
  readonly dev: string;
  readonly ino: string;
  readonly mode: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly birthtimeNs: string;
  readonly sha256?: string;
  readonly target?: string;
}

async function snapshotProviderTree(
  root: string,
): Promise<Readonly<Record<string, ProviderNodeSnapshot>>> {
  const nodes: Record<string, ProviderNodeSnapshot> = {};
  await visitProviderNode(root, root, nodes);
  return nodes;
}

async function visitProviderNode(
  root: string,
  file: string,
  nodes: Record<string, ProviderNodeSnapshot>,
): Promise<void> {
  const stats = await lstat(file, { bigint: true });
  const relative = path.relative(root, file) || ".";
  const common = {
    dev: stats.dev.toString(10),
    ino: stats.ino.toString(10),
    mode: stats.mode.toString(10),
    size: stats.size.toString(10),
    mtimeNs: stats.mtimeNs.toString(10),
    ctimeNs: stats.ctimeNs.toString(10),
    birthtimeNs: stats.birthtimeNs.toString(10),
  };
  if (stats.isDirectory()) {
    nodes[relative] = { type: "directory", ...common };
    const entries = (await readdir(file)).sort();
    for (const entry of entries) await visitProviderNode(root, path.join(file, entry), nodes);
    return;
  }
  if (stats.isFile()) {
    nodes[relative] = {
      type: "file",
      ...common,
      sha256: createHash("sha256")
        .update(await readFile(file))
        .digest("hex"),
    };
    return;
  }
  if (stats.isSymbolicLink()) {
    nodes[relative] = { type: "symlink", ...common, target: await readlink(file) };
    return;
  }
  nodes[relative] = { type: "other", ...common };
}
