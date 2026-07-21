import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import type { IndexPaths } from "../src/application/ports/index-lifecycle.ts";
import { hashContent } from "../src/domain/content-hash.ts";
import type { SessionDocument, SessionIdentity } from "../src/domain/session.ts";
import { createSqliteIndexLifecycle } from "../src/infrastructure/sqlite/database.ts";
import { counts, finishCompleted, replacement } from "./contracts/session-index.contract.ts";

const temporaryDirectories: string[] = [];
const TRANSCRIPT_MARKER = "manifest-private-transcript-marker";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("manifest process composition", () => {
  test("reads only retained metrics and emits no transcript fields", async () => {
    const fixture = await processFixture();
    const identity: SessionIdentity = {
      source: { kind: "synthetic", instanceId: "provider-free" },
      nativeId: "retained-session",
    };
    const document = privateDocument(identity);
    const admitted = replacement(identity, "manifest-process-revision", document);
    const lifecycle = createSqliteIndexLifecycle({
      now: () => new Date("2026-07-21T12:00:00.000Z"),
      writerToken: () => "manifest-process-writer",
    });
    const writer = await lifecycle.openWriter(fixture.paths);
    const run = await writer.sessions.startRun({
      source: identity.source,
      startedAt: "2026-07-21T12:00:00.000Z",
    });
    await writer.sessions.replaceSession(run, admitted);
    await finishCompleted(writer.sessions, run, counts({ discovered: 1, updated: 1 }));
    await writer.close();

    const result = invokeManifest(fixture);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(TRANSCRIPT_MARKER);
    const manifest = JSON.parse(result.stdout) as ManifestOutput;
    expect(manifest.revisionCount).toBe(1);
    expect(manifest.captureScope).toMatchObject({ status: "complete", trackedSessions: 1 });
    expect(manifest.revisions).toHaveLength(1);
    expect(manifest.revisions[0]).toEqual({
      session: {
        canonicalId: "synthetic@provider-free:retained-session",
        source: { kind: "synthetic", instanceId: "provider-free" },
        nativeId: "retained-session",
      },
      documentDigest: admitted.documentDigest,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      capturedAt: "2026-07-21T12:00:00.000Z",
      sourceObservedAt: "2026-07-21T12:00:00.000Z",
      sourceState: "present",
      freshness: "current",
      adapterVersion: "synthetic-v1",
      lineageCoverage: "unknown",
      root: { kind: "unknown" },
      counts: {
        relations: 0,
        entries: 1,
        segments: 1,
        omittedSegments: 0,
        textUtf8Bytes: Buffer.byteLength(TRANSCRIPT_MARKER, "utf8"),
      },
    });
    expect(manifest.revisions[0]).not.toHaveProperty("title");
    expect(manifest.revisions[0]).not.toHaveProperty("workspace");
    expect(manifest.revisions[0]).not.toHaveProperty("entries");
    await expectProviderTrapUntouched(fixture);
  });
});

interface ProcessFixture {
  readonly root: string;
  readonly codexHome: string;
  readonly configPath: string;
  readonly configBefore: Buffer;
  readonly homeDirectory: string;
  readonly paths: IndexPaths;
}

interface ManifestOutput {
  readonly revisionCount: number;
  readonly captureScope: Record<string, unknown>;
  readonly revisions: readonly Record<string, unknown>[];
}

async function processFixture(): Promise<ProcessFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "sessions-manifest-provider-free-"));
  temporaryDirectories.push(root);
  const codexHome = path.join(root, "codex");
  const directory = path.join(root, "sessions-data");
  const database = path.join(directory, "sessions.sqlite3");
  const configPath = path.join(codexHome, "config.toml");
  await mkdir(codexHome);
  await writeFile(configPath, "[malformed");
  return {
    root,
    codexHome,
    configPath,
    configBefore: await readFile(configPath),
    homeDirectory: path.join(root, "home"),
    paths: {
      directory,
      scratch: path.join(directory, ".scratch"),
      database,
      wal: `${database}-wal`,
      shm: `${database}-shm`,
    },
  };
}

function invokeManifest(fixture: ProcessFixture): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const binary = fileURLToPath(new URL("../src/bin/sessions.ts", import.meta.url));
  const result = spawnSync(process.execPath, [binary, "manifest", "--format", "json"], {
    cwd: fixture.root,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_HOME: fixture.codexHome,
      CODEX_SQLITE_HOME: undefined,
      HOME: fixture.homeDirectory,
      USERPROFILE: fixture.homeDirectory,
      SESSIONS_DATA_DIR: fixture.paths.directory,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

async function expectProviderTrapUntouched(fixture: ProcessFixture): Promise<void> {
  expect(existsSync(fixture.homeDirectory)).toBe(false);
  expect(await readdir(fixture.codexHome)).toEqual(["config.toml"]);
  expect(await readFile(fixture.configPath)).toEqual(fixture.configBefore);
}

function privateDocument(identity: SessionIdentity): SessionDocument {
  return {
    identity,
    title: TRANSCRIPT_MARKER,
    workspace: `/private/${TRANSCRIPT_MARKER}`,
    createdAt: "2026-07-21T10:00:00.000Z",
    updatedAt: "2026-07-21T11:00:00.000Z",
    lineageCoverage: "unknown",
    relations: [],
    entries: [
      {
        ordinal: 0,
        kind: "message",
        actor: "human",
        sourceLocator: { uri: `memory://${TRANSCRIPT_MARKER}` },
        content: [
          {
            kind: "text",
            ordinal: 0,
            text: TRANSCRIPT_MARKER,
            contentHash: hashContent(TRANSCRIPT_MARKER),
            origin: "human",
            originConfidence: "high",
            sourceMetadata: { private: TRANSCRIPT_MARKER },
          },
        ],
      },
    ],
  };
}
