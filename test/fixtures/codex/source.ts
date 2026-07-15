import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";

import type { SourceDiscoveryWorkspace } from "../../../src/application/ports/session-source.ts";
import type { CodexEnvironment } from "../../../src/adapters/codex/paths.ts";

export interface CodexFixtureThread {
  readonly id: string;
  readonly rolloutPath: string;
  readonly title?: string | null;
  readonly workspace?: string | null;
  readonly createdAtMs?: number | bigint | null;
  readonly updatedAtMs?: number | bigint | null;
}

export interface CodexFixtureEdge {
  readonly parentId: string;
  readonly childId: string;
  readonly status?: string | null;
}

export interface CodexSourceFixture {
  readonly root: string;
  readonly codexHome: string;
  readonly stateDatabase: string;
  readonly sessionsRoot: string;
  readonly archivedSessionsRoot: string;
  readonly environment: CodexEnvironment;
  readonly workspace: SourceDiscoveryWorkspace;
  writeState(threads: readonly CodexFixtureThread[], edges?: readonly CodexFixtureEdge[]): void;
  writeRollout(
    relativePath: string,
    records: string | readonly unknown[],
    representation?: "plain" | "zstd",
  ): Promise<string>;
  dispose(): Promise<void>;
}

export async function createCodexSourceFixture(): Promise<CodexSourceFixture> {
  const root = await mkdtemp(join(tmpdir(), "sessions-codex-source-"));
  const codexHome = join(root, "codex");
  const sessionsRoot = join(codexHome, "sessions");
  const archivedSessionsRoot = join(codexHome, "archived_sessions");
  const privateRoot = join(root, "private");
  const stateDatabase = join(codexHome, "state_5.sqlite");
  await Promise.all([
    mkdir(sessionsRoot, { recursive: true }),
    mkdir(archivedSessionsRoot, { recursive: true }),
    mkdir(privateRoot, { recursive: true }),
  ]);

  const workspace: SourceDiscoveryWorkspace = Object.freeze({
    async withPrivateDirectory<T>(operation: (directory: string) => Promise<T>): Promise<T> {
      const directory = await mkdtemp(join(privateRoot, "attempt-"));
      try {
        return await operation(directory);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  });

  return {
    root,
    codexHome,
    stateDatabase,
    sessionsRoot,
    archivedSessionsRoot,
    environment: {
      cwd: root,
      home: join(root, "home"),
      env: { CODEX_HOME: codexHome },
    },
    workspace,
    writeState(threads, edges = []): void {
      writeCodexStateDatabase(stateDatabase, threads, edges);
    },
    async writeRollout(relativePath, records, representation = "plain"): Promise<string> {
      const plainPath = join(codexHome, relativePath);
      const file = representation === "zstd" ? `${plainPath}.zst` : plainPath;
      const body =
        typeof records === "string"
          ? records
          : records.map((record) => JSON.stringify(record)).join("\n") + "\n";
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, representation === "zstd" ? zstdCompressSync(body) : body);
      return file;
    },
    async dispose(): Promise<void> {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function writeCodexStateDatabase(
  file: string,
  threads: readonly CodexFixtureThread[],
  edges: readonly CodexFixtureEdge[] = [],
): void {
  const database = new DatabaseSync(file);
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        title TEXT,
        cwd TEXT,
        created_at_ms INTEGER,
        updated_at_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS thread_spawn_edges (
        parent_thread_id TEXT NOT NULL,
        child_thread_id TEXT NOT NULL,
        status TEXT
      );
      DELETE FROM thread_spawn_edges;
      DELETE FROM threads;
    `);
    const insertThread = database.prepare(`
      INSERT INTO threads (
        id, rollout_path, title, cwd, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const thread of threads) {
      insertThread.run(
        thread.id,
        thread.rolloutPath,
        thread.title ?? null,
        thread.workspace ?? null,
        thread.createdAtMs ?? null,
        thread.updatedAtMs ?? null,
      );
    }
    const insertEdge = database.prepare(`
      INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status)
      VALUES (?, ?, ?)
    `);
    for (const edge of edges) insertEdge.run(edge.parentId, edge.childId, edge.status ?? null);
  } finally {
    database.close();
  }
}

export function userMessageRecord(message = "Synthetic Codex message"): unknown {
  return {
    timestamp: "2026-07-14T12:00:00.000Z",
    type: "event_msg",
    payload: { type: "user_message", message },
  };
}

export function sessionMetadataRecord(
  id: string,
  parentThreadId?: string,
  sessionId?: string,
): unknown {
  return {
    timestamp: "2026-07-14T11:59:59.000Z",
    type: "session_meta",
    payload: {
      id,
      ...(sessionId === undefined ? {} : { session_id: sessionId }),
      ...(parentThreadId === undefined ? {} : { parent_thread_id: parentThreadId }),
    },
  };
}

export function codexRolloutRecords(
  id: string,
  message = "Synthetic Codex message",
  parentThreadId?: string,
  sessionId?: string,
): readonly unknown[] {
  return [sessionMetadataRecord(id, parentThreadId, sessionId), userMessageRecord(message)];
}
