import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, test } from "vitest";

import type { SourceDiscoveryWorkspace } from "../../../src/application/ports/session-source.ts";
import {
  CodexStateSnapshotError,
  materializeCodexStateSnapshot,
} from "../../../src/adapters/codex/state-snapshot.ts";

const temporaryDirectories: string[] = [];
const openDatabases: DatabaseSync[] = [];

afterEach(async () => {
  for (const database of openDatabases.splice(0)) {
    try {
      database.close();
    } catch {
      // A fixture may close early before transferring ownership to a worker.
    }
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Codex state snapshot feasibility", () => {
  test("reads the latest uncheckpointed WAL commit without mutating provider files", async () => {
    const fixture = await activeWalFixture();
    const workspace = await testWorkspace();
    const workspaceRealRoot = realpathSync(workspace.root);
    const before = await snapshotProviderFiles(fixture.databasePath);
    let openedPath: string | undefined;
    let privateEntriesBeforeRead: readonly string[] = [];
    let privateEntries: readonly string[] = [];

    const generation = await materializeCodexStateSnapshot({
      databasePath: fixture.databasePath,
      workspace,
      materialize(database) {
        openedPath = databasePath(database);
        expect(pragmaNumber(database, "query_only")).toBe(1);
        privateEntriesBeforeRead = readdirSync(workspace.currentDirectory ?? "").sort();
        const result = readGeneration(database);
        privateEntries = readdirSync(workspace.currentDirectory ?? "").sort();
        return result;
      },
    });

    expect(generation).toEqual({ left: 1, right: 1 });
    expect(openedPath).toMatch(new RegExp(`^${escapeRegExp(workspaceRealRoot)}[/\\\\]`));
    expect(openedPath).not.toBe(fixture.databasePath);
    expect(privateEntriesBeforeRead).toEqual(["state.sqlite", "state.sqlite-wal"]);
    expect(privateEntries).toEqual(["state.sqlite", "state.sqlite-shm", "state.sqlite-wal"]);
    expect(await snapshotProviderFiles(fixture.databasePath)).toEqual(before);
    expect(await readdir(workspace.root)).toEqual([]);
  });

  test("reads committed WAL frames when the provider has no SHM", async () => {
    const origin = await activeWalFixture();
    const providerDirectory = await temporaryDirectory("sessions-codex-no-shm-");
    const databasePath = path.join(providerDirectory, "state_5.sqlite");
    await copyFile(origin.databasePath, databasePath);
    await copyFile(`${origin.databasePath}-wal`, `${databasePath}-wal`);
    await chmod(databasePath, 0o600);
    await chmod(`${databasePath}-wal`, 0o600);
    const before = await snapshotProviderFiles(databasePath);
    const workspace = await testWorkspace();

    expect(existsSync(`${databasePath}-shm`)).toBe(false);
    await expect(
      materializeCodexStateSnapshot({
        databasePath,
        workspace,
        materialize: readGeneration,
      }),
    ).resolves.toEqual({ left: 1, right: 1 });

    expect(existsSync(`${databasePath}-shm`)).toBe(false);
    expect(await snapshotProviderFiles(databasePath)).toEqual(before);
    expect(await readdir(workspace.root)).toEqual([]);
  });

  test("retries a changed generation and materializes only the stable attempt", async () => {
    const fixture = await activeWalFixture();
    const workspace = await testWorkspace();
    let materializations = 0;

    const result = await materializeCodexStateSnapshot({
      databasePath: fixture.databasePath,
      workspace,
      hooks: {
        beforePostVerification(attempt) {
          if (attempt === 1) writeGeneration(fixture.database, 2);
        },
      },
      materialize(database) {
        materializations += 1;
        return readGeneration(database);
      },
    });

    expect(result).toEqual({ left: 2, right: 2 });
    expect(workspace.attemptDirectories).toHaveLength(2);
    expect(materializations).toBe(1);
    expect(workspace.attemptDirectories.every((directory) => !existsSync(directory))).toBe(true);
  });

  test("fails closed after exactly three changing attempts", async () => {
    const fixture = await activeWalFixture();
    const workspace = await testWorkspace();
    let materializations = 0;

    const error = await materializeCodexStateSnapshot({
      databasePath: fixture.databasePath,
      workspace,
      hooks: {
        beforePostVerification(attempt) {
          writeGeneration(fixture.database, attempt + 1);
        },
      },
      materialize(database) {
        materializations += 1;
        return readGeneration(database);
      },
    }).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(CodexStateSnapshotError);
    expect(error).toMatchObject({
      kind: "source-changed",
      message: "Codex state changed while it was read",
    });
    expect(workspace.attemptDirectories).toHaveLength(3);
    expect(materializations).toBe(0);
    expect(await readdir(workspace.root)).toEqual([]);
  });

  test("cleans private database and sidecars when materialization fails", async () => {
    const fixture = await activeWalFixture();
    const workspace = await testWorkspace();
    const expected = new Error("materialization failed");
    let privateEntries: readonly string[] = [];

    await expect(
      materializeCodexStateSnapshot({
        databasePath: fixture.databasePath,
        workspace,
        materialize(database) {
          readGeneration(database);
          privateEntries = readdirSync(workspace.currentDirectory ?? "").sort();
          throw expected;
        },
      }),
    ).rejects.toBe(expected);

    expect(privateEntries).toEqual(["state.sqlite", "state.sqlite-shm", "state.sqlite-wal"]);
    expect(await readdir(workspace.root)).toEqual([]);
  });

  test("proves immutable mode misses the latest uncheckpointed commit", async () => {
    const fixture = await activeWalFixture();
    const immutable = openImmutable(fixture.databasePath);

    try {
      expect(readGeneration(immutable)).toEqual({ left: 0, right: 0 });
    } finally {
      immutable.close();
    }
  });

  test("accepts complete committed generations across WAL checkpoint and reset transitions", async () => {
    const fixture = await activeWalFixture();
    fixture.database.close();
    const databaseIndex = openDatabases.indexOf(fixture.database);
    if (databaseIndex >= 0) openDatabases.splice(databaseIndex, 1);

    const workspace = await testWorkspace();
    const writer = startConcurrentWriter(fixture.databasePath);
    expect(await writer.ready).toBe(1);

    const accepted: Generation[] = [];
    try {
      for (const checkpoint of ["none", "passive", "truncate"] as const) {
        let committedGeneration: number | undefined;
        const generation = await materializeCodexStateSnapshot({
          databasePath: fixture.databasePath,
          workspace,
          hooks: {
            async beforePostVerification(attempt) {
              if (attempt === 1) committedGeneration = await writer.advance(checkpoint);
            },
          },
          materialize: readGeneration,
        });

        if (committedGeneration === undefined) {
          throw new Error(`Worker did not acknowledge the ${checkpoint} transition`);
        }
        expect(generation).toEqual({
          left: committedGeneration,
          right: committedGeneration,
        });
        accepted.push(generation);
      }
    } finally {
      try {
        await writer.stop();
      } finally {
        await writer.worker.terminate();
      }
    }

    expect(accepted.map(({ left }) => left)).toEqual([2, 3, 4]);
    expect(workspace.attemptDirectories).toHaveLength(6);
    expect(await readdir(workspace.root)).toEqual([]);
  });
});

interface Generation {
  readonly left: number;
  readonly right: number;
}

interface ActiveWalFixture {
  readonly databasePath: string;
  readonly database: DatabaseSync;
}

async function activeWalFixture(): Promise<ActiveWalFixture> {
  const directory = await temporaryDirectory("sessions-codex-provider-");
  const databasePath = path.join(directory, "state_5.sqlite");
  const database = new DatabaseSync(databasePath);
  openDatabases.push(database);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE left_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), generation INTEGER NOT NULL) STRICT;
    CREATE TABLE right_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), generation INTEGER NOT NULL) STRICT;
    INSERT INTO left_state (singleton, generation) VALUES (1, 0);
    INSERT INTO right_state (singleton, generation) VALUES (1, 0);
  `);
  database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  writeGeneration(database, 1);
  return { databasePath, database };
}

function writeGeneration(database: DatabaseSync, generation: number): void {
  database.exec("BEGIN IMMEDIATE;");
  try {
    database.prepare("UPDATE left_state SET generation = ? WHERE singleton = 1").run(generation);
    database.prepare("UPDATE right_state SET generation = ? WHERE singleton = 1").run(generation);
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

function readGeneration(database: DatabaseSync): Generation {
  const left = database.prepare("SELECT generation FROM left_state WHERE singleton = 1").get() as
    | { readonly generation: number }
    | undefined;
  const right = database.prepare("SELECT generation FROM right_state WHERE singleton = 1").get() as
    | { readonly generation: number }
    | undefined;
  if (left === undefined || right === undefined) throw new Error("Missing generation fixture row");
  return { left: left.generation, right: right.generation };
}

function pragmaNumber(database: DatabaseSync, name: string): number {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  const value = row?.[name];
  if (typeof value !== "number") throw new Error(`Missing numeric PRAGMA ${name}`);
  return value;
}

function databasePath(database: DatabaseSync): string {
  const row = database.prepare("PRAGMA database_list").get() as
    | { readonly file: string }
    | undefined;
  if (row === undefined) throw new Error("Missing private database path");
  return row.file;
}

interface ProviderFileSnapshot {
  readonly bytes: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly birthtimeNs: bigint;
}

async function snapshotProviderFiles(
  databasePath: string,
): Promise<Readonly<Record<string, ProviderFileSnapshot>>> {
  const snapshot: Record<string, ProviderFileSnapshot> = {};
  for (const suffix of ["", "-wal", "-shm"] as const) {
    const filePath = `${databasePath}${suffix}`;
    if (!existsSync(filePath)) continue;
    const bytes = await readFile(filePath);
    const stats = await lstat(filePath, { bigint: true });
    snapshot[suffix || "database"] = {
      bytes: createHash("sha256").update(bytes).digest("hex"),
      dev: stats.dev,
      ino: stats.ino,
      mode: stats.mode,
      size: stats.size,
      mtimeNs: stats.mtimeNs,
      ctimeNs: stats.ctimeNs,
      birthtimeNs: stats.birthtimeNs,
    };
  }
  return snapshot;
}

class TestWorkspace implements SourceDiscoveryWorkspace {
  readonly root: string;
  readonly attemptDirectories: string[] = [];
  currentDirectory: string | undefined;

  constructor(root: string) {
    this.root = root;
  }

  async withPrivateDirectory<T>(operation: (directory: string) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(path.join(this.root, "attempt-"));
    this.attemptDirectories.push(directory);
    this.currentDirectory = directory;
    try {
      return await operation(directory);
    } finally {
      this.currentDirectory = undefined;
      await rm(directory, { force: true, recursive: true });
    }
  }
}

async function testWorkspace(): Promise<TestWorkspace> {
  const root = await temporaryDirectory("sessions-codex-scratch-");
  return new TestWorkspace(root);
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function openImmutable(file: string): DatabaseSync {
  const url = pathToFileURL(file);
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");
  return new DatabaseSync(url.href, { readOnly: true });
}

type CheckpointMode = "none" | "passive" | "truncate";

interface ConcurrentWriter {
  readonly worker: Worker;
  readonly ready: Promise<number>;
  readonly advance: (checkpoint: CheckpointMode) => Promise<number>;
  readonly stop: () => Promise<void>;
}

interface WorkerStatus {
  error?: Error;
  exitCode?: number;
}

interface WorkerReadyMessage {
  readonly type: "ready";
  readonly generation: number;
}

interface WorkerAdvancedMessage {
  readonly type: "advanced";
  readonly requestId: number;
  readonly checkpoint: CheckpointMode;
  readonly generation: number;
}

interface WorkerStoppedMessage {
  readonly type: "stopped";
  readonly requestId: number;
}

const WORKER_HANDSHAKE_TIMEOUT_MS = 10_000;

function startConcurrentWriter(databasePath: string): ConcurrentWriter {
  const worker = new Worker(
    `
      const { DatabaseSync } = require("node:sqlite");
      const { parentPort, workerData } = require("node:worker_threads");
      const database = new DatabaseSync(workerData.databasePath, { timeout: 1_000 });
      database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      let generation = Number(database.prepare("SELECT generation FROM left_state WHERE singleton = 1").get().generation);
      const checkpoints = {
        none: undefined,
        passive: "PRAGMA wal_checkpoint(PASSIVE);",
        truncate: "PRAGMA wal_checkpoint(TRUNCATE);",
      };

      function writeNext() {
        generation += 1;
        database.exec("BEGIN IMMEDIATE;");
        database.prepare("UPDATE left_state SET generation = ? WHERE singleton = 1").run(generation);
        database.prepare("UPDATE right_state SET generation = ? WHERE singleton = 1").run(generation);
        database.exec("COMMIT;");
      }

      function applyCheckpoint(mode) {
        const statement = checkpoints[mode];
        if (statement === undefined) return;
        const result = database.prepare(statement).get();
        // SQLite reports checkpoint contention in the result instead of throwing.
        if (Number(result.busy) !== 0) throw new Error("Checkpoint remained busy");
        if (mode === "passive" && Number(result.checkpointed) < 1) {
          throw new Error("Passive checkpoint copied no WAL frames");
        }
        if (
          mode === "truncate" &&
          (Number(result.log) !== 0 || Number(result.checkpointed) !== 0)
        ) {
          throw new Error("Truncating checkpoint did not reset the WAL");
        }
      }

      parentPort.on("message", (command) => {
        if (command.type === "advance") {
          if (!Object.hasOwn(checkpoints, command.checkpoint)) {
            throw new Error("Unknown checkpoint mode");
          }
          writeNext();
          applyCheckpoint(command.checkpoint);
          parentPort.postMessage({
            type: "advanced",
            requestId: command.requestId,
            checkpoint: command.checkpoint,
            generation,
          });
          return;
        }

        if (command.type === "stop") {
          database.close();
          parentPort.postMessage({ type: "stopped", requestId: command.requestId });
          return;
        }

        throw new Error("Unknown concurrent writer command");
      });

      parentPort.postMessage({ type: "ready", generation });
    `,
    {
      eval: true,
      workerData: { databasePath },
    },
  );

  const status: WorkerStatus = {};
  worker.on("error", (error) => {
    status.error =
      error instanceof Error ? error : new Error("Concurrent SQLite writer failed unexpectedly");
  });
  worker.on("exit", (code) => {
    status.exitCode = code;
  });

  const ready = waitForWorkerMessage(worker, status, "ready", isWorkerReadyMessage).then(
    ({ generation }) => generation,
  );
  let nextRequestId = 0;

  return {
    worker,
    ready,
    async advance(checkpoint) {
      await ready;
      const requestId = (nextRequestId += 1);
      const response = waitForWorkerMessage(
        worker,
        status,
        `${checkpoint} checkpoint acknowledgement`,
        (message): message is WorkerAdvancedMessage =>
          isWorkerAdvancedMessage(message, requestId, checkpoint),
      );
      worker.postMessage({ type: "advance", requestId, checkpoint });
      return (await response).generation;
    },
    async stop() {
      await ready;
      const requestId = (nextRequestId += 1);
      const response = waitForWorkerMessage(
        worker,
        status,
        "stop acknowledgement",
        (message): message is WorkerStoppedMessage => isWorkerStoppedMessage(message, requestId),
      );
      worker.postMessage({ type: "stop", requestId });
      await response;
    },
  };
}

function waitForWorkerMessage<T>(
  worker: Worker,
  status: WorkerStatus,
  description: string,
  matches: (message: unknown) => message is T,
): Promise<T> {
  if (status.error !== undefined) return Promise.reject(status.error);
  if (status.exitCode !== undefined) {
    return Promise.reject(
      new Error(
        `Concurrent SQLite writer exited before ${description} with code ${status.exitCode}`,
      ),
    );
  }

  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown) => {
      if (!matches(message)) return;
      cleanup();
      resolve(message);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number) => {
      cleanup();
      reject(new Error(`Concurrent SQLite writer exited before ${description} with code ${code}`));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Concurrent SQLite writer did not complete ${description} within ${WORKER_HANDSHAKE_TIMEOUT_MS}ms`,
        ),
      );
    }, WORKER_HANDSHAKE_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timeout);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
  });
}

function isWorkerReadyMessage(message: unknown): message is WorkerReadyMessage {
  return isRecord(message) && message.type === "ready" && isGeneration(message.generation);
}

function isWorkerAdvancedMessage(
  message: unknown,
  requestId: number,
  checkpoint: CheckpointMode,
): message is WorkerAdvancedMessage {
  return (
    isRecord(message) &&
    message.type === "advanced" &&
    message.requestId === requestId &&
    message.checkpoint === checkpoint &&
    isGeneration(message.generation)
  );
}

function isWorkerStoppedMessage(
  message: unknown,
  requestId: number,
): message is WorkerStoppedMessage {
  return isRecord(message) && message.type === "stopped" && message.requestId === requestId;
}

function isGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
