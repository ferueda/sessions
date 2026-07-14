import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface PackedFile {
  readonly path: string;
}

interface PackResult {
  readonly filename: string;
  readonly files: readonly PackedFile[];
}

const root = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "sessions-package-"));

try {
  const packOutput = runPackageManager(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", temporaryRoot],
    root,
  );
  const packed = (JSON.parse(packOutput.stdout) as readonly PackResult[])[0];
  if (!packed) throw new Error("npm pack returned no package");

  const paths = packed.files.map((file) => file.path);
  const forbidden = paths.filter((file) => /^(src|scripts|test|docs|dev)\//u.test(file));
  if (forbidden.length > 0) {
    throw new Error(`tarball contains repository-only files: ${forbidden.join(", ")}`);
  }
  for (const required of ["package.json", "README.md", "LICENSE", "dist/bin/sessions.js"]) {
    if (!paths.includes(required)) throw new Error(`tarball is missing ${required}`);
  }

  const project = path.join(temporaryRoot, "project");
  const stateDirectory = path.join(temporaryRoot, "state");
  const isolatedEnvironment = { ...process.env, SESSIONS_CACHE_DIR: stateDirectory };
  await mkdir(project);
  await writeFile(
    path.join(project, "package.json"),
    `${JSON.stringify({ name: "sessions-package-smoke", private: true }, null, 2)}\n`,
  );

  const tarball = path.join(temporaryRoot, packed.filename);
  const store = runPackageManager("pnpm", ["store", "path", "--silent"], root).stdout.trim();
  if (store.length === 0) throw new Error("pnpm store path returned no path");
  runPackageManager(
    "pnpm",
    ["add", "--offline", "--ignore-scripts", "--store-dir", store, tarball],
    project,
  );

  const help = runPackageManager(
    "pnpm",
    ["exec", "sessions", "--help"],
    project,
    isolatedEnvironment,
  );
  if (!help.stdout.includes("Usage: sessions") || help.stderr !== "") {
    throw new Error(`installed binary returned invalid help: ${JSON.stringify(help)}`);
  }

  const version = runPackageManager(
    "pnpm",
    ["exec", "sessions", "--version"],
    project,
    isolatedEnvironment,
  );
  if (!/^\d+\.\d+\.\d+\s*$/u.test(version.stdout)) {
    throw new Error(`installed binary returned an invalid version: ${version.stdout}`);
  }

  const doctor = runPackageManager(
    "pnpm",
    ["exec", "sessions", "doctor", "--format", "json"],
    project,
    isolatedEnvironment,
  );
  const report = JSON.parse(doctor.stdout) as { schemaVersion?: unknown; ok?: unknown };
  if (report.schemaVersion !== 1 || report.ok !== true) {
    throw new Error(`installed binary returned an invalid doctor report: ${doctor.stdout}`);
  }

  const pathsCommand = runPackageManager(
    "pnpm",
    ["exec", "sessions", "paths", "--format", "json"],
    project,
    isolatedEnvironment,
  );
  const pathsReport = JSON.parse(pathsCommand.stdout) as {
    schemaVersion?: unknown;
    command?: unknown;
    index?: { directory?: unknown; initialized?: unknown };
  };
  if (
    pathsReport.schemaVersion !== 1 ||
    pathsReport.command !== "paths" ||
    pathsReport.index?.directory !== stateDirectory ||
    pathsReport.index.initialized !== false
  ) {
    throw new Error(`installed binary returned an invalid paths report: ${pathsCommand.stdout}`);
  }
  if (existsSync(stateDirectory)) throw new Error("installed doctor or paths created state");
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  shell = false,
  env: NodeJS.ProcessEnv = process.env,
): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env, shell });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${String(result.status)}): ${result.stderr || result.stdout}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function runPackageManager(
  command: "npm" | "pnpm",
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): { stdout: string; stderr: string } {
  // npm and pnpm are .cmd shims on Windows; Node requires a command shell for them.
  return run(command, args, cwd, process.platform === "win32", env);
}
