import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("paths persistence boundary", () => {
  test("reports an absent owned directory without creating state", async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), "sessions-paths-sandbox-"));
    temporaryDirectories.push(sandbox);
    const ownedDirectory = path.join(sandbox, "owned-state");
    const binary = fileURLToPath(new URL("../src/bin/sessions.ts", import.meta.url));
    const result = spawnSync(process.execPath, [binary, "paths", "--format", "json"], {
      cwd: sandbox,
      encoding: "utf8",
      env: {
        ...process.env,
        SESSIONS_CACHE_DIR: ownedDirectory,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      command: "paths",
      index: {
        directory: ownedDirectory,
        initialized: false,
        state: "uninitialized",
      },
    });
    await expect(readdir(sandbox, { recursive: true })).resolves.toEqual([]);
  });
});
