import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";

import {
  readConfiguredSqliteHome,
  type CodexConfigError,
} from "../../../src/adapters/codex/config.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Codex configuration", () => {
  test("admits only a top-level string sqlite_home from bounded TOML", async () => {
    const root = await temporaryRoot();
    const file = join(root, "config.toml");
    await writeFile(
      file,
      `# source configuration\nsqlite_home = "state/current"\n[project]\nsqlite_home = "ignored"\n`,
    );

    await expect(readConfiguredSqliteHome(file)).resolves.toBe("state/current");
  });

  test("treats missing and nested-only configuration as unconfigured", async () => {
    const root = await temporaryRoot();
    await expect(readConfiguredSqliteHome(join(root, "missing.toml"))).resolves.toBeUndefined();
    const nested = join(root, "nested.toml");
    await writeFile(nested, `[project]\nsqlite_home = "ignored"\n`);

    await expect(readConfiguredSqliteHome(nested)).resolves.toBeUndefined();
  });

  test.each([`sqlite_home = 42\n`, `sqlite_home = ""\n`, `sqlite_home = [\n`])(
    "sanitizes malformed values",
    async (body) => {
      const root = await temporaryRoot();
      const file = join(root, "config.toml");
      await writeFile(file, body);

      await expect(readConfiguredSqliteHome(file)).rejects.toMatchObject({
        name: "CodexConfigError",
        failure: "malformed",
        message: "Codex configuration could not be read",
      } satisfies Partial<CodexConfigError>);
    },
  );

  test("rejects invalid UTF-8, non-files, and content beyond one MiB", async () => {
    const root = await temporaryRoot();
    const invalidUtf8 = join(root, "invalid.toml");
    const directory = join(root, "directory.toml");
    const oversized = join(root, "oversized.toml");
    await writeFile(invalidUtf8, Buffer.from([0xff]));
    await mkdir(directory);
    await writeFile(oversized, Buffer.alloc(1024 * 1024 + 1, 0x20));

    for (const file of [invalidUtf8, directory, oversized]) {
      await expect(readConfiguredSqliteHome(file)).rejects.toMatchObject({
        failure: "malformed",
        message: "Codex configuration could not be read",
      });
    }
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sessions-codex-config-"));
  roots.push(root);
  return root;
}
