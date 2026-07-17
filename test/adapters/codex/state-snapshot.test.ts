import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import type { SourceCaptureWorkspace } from "../../../src/application/ports/session-source.ts";
import {
  CodexStateSnapshotError,
  materializeCodexStateSnapshot,
} from "../../../src/adapters/codex/state-snapshot.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Codex state snapshot compatibility", () => {
  test("materializes a main-only provider database through the shared snapshot", async () => {
    const providerDirectory = await temporaryDirectory("sessions-codex-provider-");
    const databasePath = path.join(providerDirectory, "state_5.sqlite");
    const providerDatabase = new DatabaseSync(databasePath);
    providerDatabase.exec("CREATE TABLE state (value TEXT NOT NULL) STRICT;");
    providerDatabase.prepare("INSERT INTO state (value) VALUES (?)").run("ready");
    providerDatabase.close();

    const result = await materializeCodexStateSnapshot({
      databasePath,
      workspace: await testWorkspace(),
      materialize(database) {
        const row = database.prepare("SELECT value FROM state").get() as
          | { readonly value: string }
          | undefined;
        return row?.value;
      },
    });

    expect(result).toBe("ready");
  });

  test("preserves the Codex error contract for shared snapshot failures", async () => {
    const providerDirectory = await temporaryDirectory("sessions-codex-provider-");
    const missingPath = path.join(providerDirectory, "missing.sqlite");

    const error = await materializeCodexStateSnapshot({
      databasePath: missingPath,
      workspace: await testWorkspace(),
      materialize() {
        return undefined;
      },
    }).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(CodexStateSnapshotError);
    expect(error).toMatchObject({
      kind: "unreadable",
      message: "Codex state is unreadable",
    });
  });

  test("maps exhausted shared retries to the Codex source-changed error", async () => {
    const providerDirectory = await temporaryDirectory("sessions-codex-provider-");
    const databasePath = path.join(providerDirectory, "state_5.sqlite");
    const providerDatabase = new DatabaseSync(databasePath);
    providerDatabase.exec(
      "CREATE TABLE state (singleton INTEGER PRIMARY KEY, value INTEGER NOT NULL) STRICT;",
    );
    providerDatabase.exec("INSERT INTO state (singleton, value) VALUES (1, 0);");
    providerDatabase.close();
    let materializations = 0;

    const error = await materializeCodexStateSnapshot({
      databasePath,
      workspace: await testWorkspace(),
      hooks: {
        beforePostVerification() {
          const writer = new DatabaseSync(databasePath);
          try {
            writer.exec("UPDATE state SET value = value + 1 WHERE singleton = 1;");
          } finally {
            writer.close();
          }
        },
      },
      materialize() {
        materializations += 1;
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
    expect(materializations).toBe(0);
  });

  test("does not translate errors raised by Codex materialization", async () => {
    const providerDirectory = await temporaryDirectory("sessions-codex-provider-");
    const databasePath = path.join(providerDirectory, "state_5.sqlite");
    const providerDatabase = new DatabaseSync(databasePath);
    providerDatabase.exec("CREATE TABLE state (value TEXT NOT NULL) STRICT;");
    providerDatabase.close();
    const expected = new CodexStateSnapshotError("malformed");

    await expect(
      materializeCodexStateSnapshot({
        databasePath,
        workspace: await testWorkspace(),
        materialize() {
          throw expected;
        },
      }),
    ).rejects.toBe(expected);
  });
});

class TestWorkspace implements SourceCaptureWorkspace {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async withPrivateDirectory<T>(operation: (directory: string) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(path.join(this.root, "attempt-"));
    try {
      return await operation(directory);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }
}

async function testWorkspace(): Promise<TestWorkspace> {
  return new TestWorkspace(await temporaryDirectory("sessions-codex-scratch-"));
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}
