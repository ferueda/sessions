import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

test.each([undefined, "1"])(
  "rejects invalid index paths before provider resolution with timing=$timing",
  async (timing) => {
    const root = await mkdtemp(path.join(tmpdir(), "sessions-index-path-order-"));
    temporaryDirectories.push(root);
    const codexHome = path.join(root, "codex");
    await mkdir(codexHome);
    await writeFile(path.join(codexHome, "config.toml"), "[malformed");
    const binary = fileURLToPath(new URL("../src/bin/sessions.ts", import.meta.url));

    const result = spawnSync(process.execPath, [binary, "index", "--source", "codex"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CODEX_SQLITE_HOME: undefined,
        HOME: path.join(root, "home"),
        USERPROFILE: path.join(root, "home"),
        SESSIONS_DATA_DIR: "relative-sessions-data",
        SESSIONS_INDEX_TIMINGS: timing,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("sessions: SESSIONS_DATA_DIR must be an absolute path\n");
    expect(result.stderr).not.toContain("Codex config");
  },
);
