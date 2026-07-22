import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { checkProductionDependencies } from "../scripts/check-dependencies.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("production dependency boundaries", () => {
  test("keeps every source layer within the accepted import graph", async () => {
    const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));
    const result = await checkProductionDependencies(sourceRoot);

    expect(result.moduleCount).toBeGreaterThan(0);
    expect(result.internalDependencyCount).toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
  });

  test("rejects a forbidden cross-layer import", async () => {
    const sourceRoot = await fixture({
      "domain/model.ts": 'import "../infrastructure/database.ts";\n',
      "infrastructure/database.ts": "export {};\n",
    });

    const result = await checkProductionDependencies(sourceRoot);

    expect(result.violations).toEqual([
      "domain/model.ts (domain) -> ../infrastructure/database.ts (infrastructure)",
    ]);
  });

  test("rejects a relative import escaping the production root", async () => {
    const sourceRoot = await fixture({
      "application/use-case.ts": 'import "../../shared.ts";\n',
    });

    const result = await checkProductionDependencies(sourceRoot);

    expect(result.violations).toEqual([
      "application/use-case.ts (application) -> ../../shared.ts (outside src)",
    ]);
  });
});

describe("certified index mutation boundary", () => {
  test("keeps persistent session-index writes behind the certified wrapper", async () => {
    const source = await readFile(
      fileURLToPath(
        new URL("../src/infrastructure/sqlite/sqlite-session-index.ts", import.meta.url),
      ),
      "utf8",
    );

    expect(source).toContain("runCertifiedIndexMutation");
    expect(source).not.toMatch(/\brunImmediateTransaction\b/u);
    expect(source).not.toMatch(/\brunLeasedImmediateTransaction\b/u);
  });
});

async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "sessions-architecture-"));
  temporaryDirectories.push(directory);
  const sourceRoot = path.join(directory, "src");

  for (const [relativePath, contents] of Object.entries(files)) {
    const file = path.join(sourceRoot, relativePath);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents);
  }

  return sourceRoot;
}
