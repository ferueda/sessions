import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const binary = fileURLToPath(new URL("../dist/bin/sessions.js", import.meta.url));
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "sessions-dist-smoke-"));
const stateDirectory = path.join(temporaryRoot, "state");
const isolatedEnvironment = { ...process.env, SESSIONS_CACHE_DIR: stateDirectory };

try {
  const help = run([binary, "--help"], isolatedEnvironment);
  if (!help.stdout.includes("Usage: sessions") || help.stderr !== "") {
    throw new Error(`unexpected help output: ${JSON.stringify(help)}`);
  }

  const version = run([binary, "--version"], isolatedEnvironment);
  if (!/^\d+\.\d+\.\d+\s*$/u.test(version.stdout)) {
    throw new Error(`unexpected version output: ${JSON.stringify(version.stdout)}`);
  }

  const doctor = run([binary, "doctor", "--format", "json"], isolatedEnvironment);
  const report = JSON.parse(doctor.stdout) as {
    schemaVersion?: unknown;
    command?: unknown;
    ok?: unknown;
    checks?: readonly { id?: unknown }[];
  };
  const checkIds = report.checks?.map((check) => check.id);
  if (
    report.schemaVersion !== 1 ||
    report.command !== "doctor" ||
    report.ok !== true ||
    JSON.stringify(checkIds) !== JSON.stringify(["node-runtime", "sqlite-fts5", "index-state"])
  ) {
    throw new Error(`unexpected doctor report: ${doctor.stdout}`);
  }

  const paths = run([binary, "paths", "--format", "json"], isolatedEnvironment);
  const pathsReport = JSON.parse(paths.stdout) as {
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
    throw new Error(`unexpected paths report: ${paths.stdout}`);
  }
  if (existsSync(stateDirectory)) throw new Error("doctor or paths created persistent state");
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}

function run(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, args, { encoding: "utf8", env });
  if (result.status !== 0) {
    throw new Error(
      `dist smoke failed (${String(result.status)}): ${result.stderr || result.stdout}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}
