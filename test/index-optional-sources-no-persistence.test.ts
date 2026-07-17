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

describe("optional source indexing persistence boundary", () => {
  test("skips an unavailable implicit source without creating Sessions state", async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), "sessions-index-optional-"));
    temporaryDirectories.push(sandbox);
    const binary = fileURLToPath(new URL("../src/bin/sessions.ts", import.meta.url));
    const result = spawnSync(process.execPath, [binary, "index", "--format", "json"], {
      cwd: sandbox,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: path.join(sandbox, "codex"),
        CODEX_SQLITE_HOME: undefined,
        SESSIONS_DATA_DIR: path.join(sandbox, "sessions-data"),
        HOME: path.join(sandbox, "home"),
        USERPROFILE: path.join(sandbox, "home"),
      },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      command: "index",
      counts: {
        discovered: 0,
        unchanged: 0,
        updated: 0,
        failed: 0,
        missing: 0,
        stale: 0,
      },
      sources: [
        {
          source: { kind: "codex" },
          status: "skipped",
          reason: "source-unavailable",
          coverage: { status: "not-attempted" },
        },
      ],
      incompleteSources: 0,
      skippedSources: 1,
      omittedItemCount: 0,
    });
    await expect(readdir(sandbox, { recursive: true })).resolves.toEqual([]);
  });
});
