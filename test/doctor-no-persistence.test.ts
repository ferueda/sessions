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

describe("doctor persistence boundary", () => {
  test("creates no state beneath isolated working, home, cache, or temp paths", async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), "sessions-doctor-sandbox-"));
    temporaryDirectories.push(sandbox);
    const binary = fileURLToPath(new URL("../src/bin/sessions.ts", import.meta.url));
    const result = spawnSync(process.execPath, [binary, "doctor", "--format", "json"], {
      cwd: sandbox,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: path.join(sandbox, "codex"),
        CODEX_SQLITE_HOME: undefined,
        SESSIONS_DATA_DIR: path.join(sandbox, "sessions-data"),
        HOME: path.join(sandbox, "home"),
        USERPROFILE: path.join(sandbox, "home"),
        XDG_CACHE_HOME: path.join(sandbox, "cache"),
        XDG_DATA_HOME: path.join(sandbox, "data"),
        LOCALAPPDATA: path.join(sandbox, "local-app-data"),
        APPDATA: path.join(sandbox, "app-data"),
        TMPDIR: path.join(sandbox, "temp"),
        TEMP: path.join(sandbox, "temp"),
        TMP: path.join(sandbox, "temp"),
      },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as {
      readonly checks?: readonly {
        readonly id?: unknown;
        readonly ok?: unknown;
        readonly summary?: unknown;
        readonly details?: unknown;
      }[];
    };
    expect(report).toMatchObject({
      schemaVersion: 1,
      command: "doctor",
      ok: true,
    });
    expect(report.checks?.map((check) => check.id)).toEqual([
      "node-runtime",
      "sqlite-fts5",
      "library-state",
      "source-codex",
    ]);
    expect(report.checks?.at(-1)).toEqual({
      id: "source-codex",
      label: "codex source",
      ok: true,
      summary: "Source is unavailable (optional)",
      details: { probeStatus: "unavailable" },
    });
    await expect(readdir(sandbox, { recursive: true })).resolves.toEqual([]);
  });
});
