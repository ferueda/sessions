import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("fresh list composition", () => {
  test("does not resolve malformed provider configuration or create state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sessions-list-lazy-source-"));
    temporaryDirectories.push(root);
    const codexHome = path.join(root, "codex");
    const dataDirectory = path.join(root, "sessions-data");
    await mkdir(codexHome);
    await writeFile(path.join(codexHome, "config.toml"), "[malformed");
    const binary = fileURLToPath(new URL("../src/bin/sessions.ts", import.meta.url));

    const result = spawnSync(process.execPath, [binary, "list"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CODEX_SQLITE_HOME: undefined,
        HOME: path.join(root, "home"),
        USERPROFILE: path.join(root, "home"),
        SESSIONS_DATA_DIR: dataDirectory,
      },
    });

    expect(result).toMatchObject({
      status: 0,
      stdout: "No sessions found.\n",
      stderr: "",
    });
    expect(existsSync(dataDirectory)).toBe(false);
  });
});
