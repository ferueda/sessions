import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runM6SmokeWorkflow } from "./smoke-m6-workflow.ts";

const binary = fileURLToPath(new URL("../dist/bin/sessions.js", import.meta.url));
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "sessions-dist-smoke-"));

try {
  const help = run([binary, "--help"]);
  if (help.status !== 0 || !help.stdout.includes("Usage: sessions") || help.stderr !== "") {
    throw new Error(`unexpected help output: ${JSON.stringify(help)}`);
  }

  const version = run([binary, "--version"]);
  if (version.status !== 0 || !/^\d+\.\d+\.\d+\s*$/u.test(version.stdout)) {
    throw new Error(`unexpected version output: ${JSON.stringify(version.stdout)}`);
  }
  await runM6SmokeWorkflow({
    temporaryRoot,
    run: (args, environment) => run([binary, ...args], environment),
  });
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}

function run(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, args, { encoding: "utf8", env });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
