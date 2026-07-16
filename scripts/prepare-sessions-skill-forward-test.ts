import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createSessionsSkillForwardCorpus,
  sessionsSkillForwardCases,
  type SessionsSkillForwardCorpus,
} from "../test/fixtures/sessions-skill-forward.ts";

interface PackResult {
  readonly filename: string;
}

interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface StopLatch {
  readonly promise: Promise<"input" | "end" | "SIGINT" | "SIGTERM">;
  readonly settled: boolean;
  resolve(reason: "input" | "end" | "SIGINT" | "SIGTERM"): void;
}

type ProviderTree = Readonly<Record<string, ProviderNode>>;
type ProviderNode =
  | { readonly kind: "directory" }
  | { readonly kind: "file"; readonly bytes: string; readonly sha256: string }
  | { readonly kind: "symlink"; readonly target: string }
  | { readonly kind: "other" };

const root = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "sessions-skill-forward-"));
const stop = createStopLatch();
let corpus: SessionsSkillForwardCorpus | undefined;
let corpusDisposed = false;

const onSigint = () => stop.resolve("SIGINT");
const onSigterm = () => stop.resolve("SIGTERM");
const onInput = () => stop.resolve("input");
const onEnd = () => stop.resolve("end");
process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);

try {
  runChecked("pnpm", ["build"], root);
  const installedPackage = await installPackage(temporaryRoot);
  const installedBinary = path.join(installedPackage, "dist", "bin", "sessions.js");
  const skillPath = path.join(installedPackage, "skills", "sessions");
  assert.equal(existsSync(installedBinary), true, "installed package has no Sessions binary");
  assert.equal(
    existsSync(path.join(skillPath, "SKILL.md")),
    true,
    "installed package has no skill",
  );

  const libraryDirectory = path.join(temporaryRoot, "library");
  const agentHome = path.join(temporaryRoot, "agent-home");
  const agentWorkspace = path.join(temporaryRoot, "agent-workspace");
  await Promise.all([mkdir(agentHome), mkdir(agentWorkspace)]);

  corpus = await createSessionsSkillForwardCorpus();
  const baseEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    SESSIONS_DATA_DIR: libraryDirectory,
    HOME: agentHome,
    USERPROFILE: agentHome,
    CODEX_SQLITE_HOME: "",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  };

  await indexSourceReadOnly(installedBinary, corpus.knownSource.codexHome, baseEnvironment, 5);
  await indexSourceReadOnly(installedBinary, corpus.unknownSource.codexHome, baseEnvironment, 1);

  const unavailableCodexHome = corpus.unknownSource.codexHome;
  await corpus.dispose();
  corpusDisposed = true;
  assert.equal(existsSync(corpus.knownSource.root), false, "known provider fixture was retained");
  assert.equal(
    existsSync(corpus.unknownSource.root),
    false,
    "unknown provider fixture was retained",
  );

  const unavailableEnvironment: NodeJS.ProcessEnv = {
    ...baseEnvironment,
    CODEX_HOME: unavailableCodexHome,
  };
  assertRetainedLibraryReady(installedBinary, unavailableEnvironment);

  const launcherDirectory = path.join(temporaryRoot, "bin");
  const sessionsCommand = path.join(launcherDirectory, "sessions");
  await mkdir(launcherDirectory);
  await writeFile(sessionsCommand, launcherSource(installedBinary, unavailableEnvironment), {
    mode: 0o700,
  });
  await chmod(sessionsCommand, 0o700);

  const agentPath = [launcherDirectory, process.env.PATH ?? ""]
    .filter(Boolean)
    .join(path.delimiter);
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      agentWorkspace,
      skillPath,
      sessionsCommand,
      agentEnvironment: { PATH: agentPath },
      cases: sessionsSkillForwardCases.map(({ id, prompt }) => ({ id, prompt })),
      cleanup: "Write any input or close stdin after all fresh-agent evaluations finish.",
    })}\n`,
  );

  if (!stop.settled) {
    process.stdin.once("data", onInput);
    process.stdin.once("end", onEnd);
    process.stdin.resume();
  }
  const reason = await stop.promise;
  if (reason === "SIGINT") process.exitCode = 130;
  if (reason === "SIGTERM") process.exitCode = 143;
} finally {
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
  process.stdin.removeListener("data", onInput);
  process.stdin.removeListener("end", onEnd);
  process.stdin.pause();
  if (corpus !== undefined && !corpusDisposed) await corpus.dispose().catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function installPackage(temporaryDirectory: string): Promise<string> {
  const packOutput = runChecked(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", temporaryDirectory],
    root,
  );
  const packed = (JSON.parse(packOutput.stdout) as readonly PackResult[])[0];
  if (packed === undefined) throw new Error("npm pack returned no package");

  const project = path.join(temporaryDirectory, "package");
  await mkdir(project);
  await writeFile(
    path.join(project, "package.json"),
    `${JSON.stringify({ name: "sessions-skill-forward-test", private: true }, null, 2)}\n`,
  );
  const store = runChecked("pnpm", ["store", "path", "--silent"], root).stdout.trim();
  if (store.length === 0) throw new Error("pnpm store path returned no path");
  runChecked(
    "pnpm",
    [
      "add",
      "--offline",
      "--ignore-scripts",
      "--store-dir",
      store,
      path.join(temporaryDirectory, packed.filename),
    ],
    project,
  );

  const installed = path.join(project, "node_modules", "@ferueda", "sessions");
  const target = await realpath(installed);
  if (target === root || target.startsWith(`${root}${path.sep}`)) {
    throw new Error("forward-test package resolves into the source checkout");
  }
  return installed;
}

async function indexSourceReadOnly(
  binary: string,
  codexHome: string,
  baseEnvironment: NodeJS.ProcessEnv,
  expectedUpdated: number,
): Promise<void> {
  const before = await snapshotProviderTree(codexHome);
  const result = runCli(binary, ["index", "--source", "codex", "--format", "json"], {
    ...baseEnvironment,
    CODEX_HOME: codexHome,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "", "index wrote unexpected stderr");
  const report = parseObject(result.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.command, "index");
  assert.equal(report.incompleteSources, 0);
  const counts = readObject(report.counts, "index counts");
  assert.equal(counts.discovered, expectedUpdated);
  assert.equal(counts.updated, expectedUpdated);
  assert.equal(counts.failed, 0);
  assert.deepEqual(await snapshotProviderTree(codexHome), before, "index mutated provider files");
}

function assertRetainedLibraryReady(binary: string, environment: NodeJS.ProcessEnv): void {
  const doctor = runCli(binary, ["doctor", "--format", "json"], environment);
  assert.equal(doctor.status, 1, "doctor should report the unavailable synthetic source");
  const report = parseObject(doctor.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.command, "doctor");
  assert.equal(report.ok, false);
  const checks = readArray(report.checks, "doctor checks").map((value) =>
    readObject(value, "doctor check"),
  );
  assert.equal(checks.find(({ id }) => id === "library-state")?.ok, true);
  assert.equal(checks.find(({ id }) => id === "source-codex")?.ok, false);

  const list = runCli(binary, ["list", "--format", "json", "--limit", "10"], environment);
  assert.equal(list.status, 0, list.stderr || list.stdout);
  assert.equal(list.stderr, "");
  const sessions = readArray(parseObject(list.stdout).sessions, "retained sessions");
  assert.equal(sessions.length, 6, "retained library does not contain the complete corpus");
}

function launcherSource(binary: string, environment: NodeJS.ProcessEnv): string {
  const fixedEnvironment = {
    SESSIONS_DATA_DIR: environment.SESSIONS_DATA_DIR,
    HOME: environment.HOME,
    USERPROFILE: environment.USERPROFILE,
    CODEX_HOME: environment.CODEX_HOME,
    CODEX_SQLITE_HOME: "",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  };
  return `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const result = spawnSync(process.execPath, [${JSON.stringify(binary)}, ...process.argv.slice(2)], {
  env: { ...process.env, ...${JSON.stringify(fixedEnvironment)} },
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`;
}

function runCli(
  binary: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): CommandResult {
  return run(process.execPath, [binary, ...args], root, environment);
}

function runChecked(
  command: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): CommandResult {
  const result = run(command, args, cwd, environment);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${String(result.status)}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: environment,
    shell: process.platform === "win32" && (command === "npm" || command === "pnpm"),
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function parseObject(value: string): Readonly<Record<string, unknown>> {
  return readObject(JSON.parse(value), "JSON output");
}

function readObject(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function readArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`);
  return value;
}

async function snapshotProviderTree(rootDirectory: string): Promise<ProviderTree> {
  const nodes: Record<string, ProviderNode> = {};
  await visitProviderNode(rootDirectory, rootDirectory, nodes);
  return nodes;
}

async function visitProviderNode(
  rootDirectory: string,
  file: string,
  nodes: Record<string, ProviderNode>,
): Promise<void> {
  const stats = await lstat(file, { bigint: true });
  const relative = path.relative(rootDirectory, file) || ".";
  if (stats.isDirectory()) {
    nodes[relative] = { kind: "directory" };
    for (const entry of (await readdir(file)).sort()) {
      await visitProviderNode(rootDirectory, path.join(file, entry), nodes);
    }
    return;
  }
  if (stats.isFile()) {
    nodes[relative] = {
      kind: "file",
      bytes: stats.size.toString(10),
      sha256: createHash("sha256")
        .update(await readFile(file))
        .digest("hex"),
    };
    return;
  }
  if (stats.isSymbolicLink()) {
    nodes[relative] = { kind: "symlink", target: await readlink(file) };
    return;
  }
  nodes[relative] = { kind: "other" };
}

function createStopLatch(): StopLatch {
  let settled = false;
  let resolvePromise: (reason: "input" | "end" | "SIGINT" | "SIGTERM") => void = () => {};
  const promise = new Promise<"input" | "end" | "SIGINT" | "SIGTERM">((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    get settled() {
      return settled;
    },
    resolve(reason) {
      if (settled) return;
      settled = true;
      resolvePromise(reason);
    },
  };
}
