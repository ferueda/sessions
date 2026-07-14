import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { classifyDocumentationOnlyChanges } from "../scripts/classify-ci-changes.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("CI change classification", () => {
  test("uses the pull-request merge base when the base branch advanced", async () => {
    const repository = await createRepository();
    const initialSha = git(repository, "rev-parse", "HEAD");

    git(repository, "switch", "-c", "docs-change");
    await writeFile(path.join(repository, "README.md"), "# Documentation\n");
    git(repository, "add", "README.md");
    git(repository, "commit", "--no-verify", "-m", "Document usage");
    const headSha = git(repository, "rev-parse", "HEAD");

    git(repository, "switch", "main");
    await writeFile(path.join(repository, "source.ts"), "export {};\n");
    git(repository, "add", "source.ts");
    git(repository, "commit", "--no-verify", "-m", "Advance main");
    const advancedBaseSha = git(repository, "rev-parse", "HEAD");

    expect(
      classifyDocumentationOnlyChanges({
        cwd: repository,
        eventName: "pull_request",
        baseSha: advancedBaseSha,
        headSha,
      }),
    ).toBe(true);
    expect(
      classifyDocumentationOnlyChanges({
        cwd: repository,
        eventName: "push",
        baseSha: advancedBaseSha,
        headSha,
      }),
    ).toBe(false);
    expect(
      classifyDocumentationOnlyChanges({
        cwd: repository,
        eventName: "push",
        baseSha: initialSha,
        headSha,
      }),
    ).toBe(true);
  });

  test("falls back to full checks for invalid or empty ranges", async () => {
    const repository = await createRepository();
    const sha = git(repository, "rev-parse", "HEAD");

    expect(
      classifyDocumentationOnlyChanges({
        cwd: repository,
        eventName: "pull_request",
        baseSha: sha,
        headSha: sha,
      }),
    ).toBe(false);
    expect(
      classifyDocumentationOnlyChanges({
        cwd: repository,
        eventName: "push",
        baseSha: "missing",
        headSha: sha,
      }),
    ).toBe(false);
  });
});

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(path.join(tmpdir(), "sessions-ci-scope-"));
  temporaryDirectories.push(repository);
  git(repository, "init", "--initial-branch", "main");
  git(repository, "config", "user.name", "Sessions Test");
  git(repository, "config", "user.email", "sessions@example.invalid");
  git(repository, "config", "commit.gpgSign", "false");
  await writeFile(path.join(repository, "initial.txt"), "initial\n");
  git(repository, "add", "initial.txt");
  git(repository, "commit", "--no-verify", "-m", "Initial commit");
  return repository;
}

function git(repository: string, ...args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}
