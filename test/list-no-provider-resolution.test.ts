import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

const absentQueryCases = [
  {
    command: "list",
    argv: ["list"],
    expected: { status: 0, stdout: "No sessions found.\n", stderr: "" },
  },
  {
    command: "search",
    argv: ["search", "needle"],
    expected: { status: 0, stdout: "No matches found.\n", stderr: "" },
  },
  {
    command: "entries",
    argv: ["entries"],
    expected: { status: 0, stdout: "No entries found.\n", stderr: "" },
  },
  {
    command: "show",
    argv: ["show", "codex@default:missing"],
    expected: { status: 1, stdout: "", stderr: "sessions: Session was not found\n" },
  },
  {
    command: "export",
    argv: ["export", "codex@default:missing", "--format", "json"],
    expected: { status: 1, stdout: "", stderr: "sessions: Session was not found\n" },
  },
] as const;

describe("fresh retained-query composition", () => {
  test.each(absentQueryCases)(
    "keeps $command provider-free and leaves absent storage untouched",
    async ({ command, argv, expected }) => {
      const root = await mkdtemp(path.join(tmpdir(), `sessions-${command}-lazy-source-`));
      temporaryDirectories.push(root);
      const codexHome = path.join(root, "codex");
      const dataDirectory = path.join(root, "sessions-data");
      const homeDirectory = path.join(root, "home");
      const configPath = path.join(codexHome, "config.toml");
      await mkdir(codexHome);
      await writeFile(configPath, "[malformed");
      const providerConfigBefore = await readFile(configPath);
      const binary = fileURLToPath(new URL("../src/bin/sessions.ts", import.meta.url));

      const result = spawnSync(process.execPath, [binary, ...argv], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
          CODEX_SQLITE_HOME: undefined,
          HOME: homeDirectory,
          USERPROFILE: homeDirectory,
          SESSIONS_DATA_DIR: dataDirectory,
        },
      });

      expect(result).toMatchObject(expected);
      expect(existsSync(dataDirectory)).toBe(false);
      expect(existsSync(homeDirectory)).toBe(false);
      expect(await readdir(codexHome)).toEqual(["config.toml"]);
      expect(await readFile(configPath)).toEqual(providerConfigBefore);
    },
  );
});
