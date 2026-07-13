import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const binary = fileURLToPath(new URL("../dist/bin/sessions.js", import.meta.url));

const help = run([binary, "--help"]);
if (!help.stdout.includes("Usage: sessions") || help.stderr !== "") {
  throw new Error(`unexpected help output: ${JSON.stringify(help)}`);
}

const version = run([binary, "--version"]);
if (!/^\d+\.\d+\.\d+\s*$/u.test(version.stdout)) {
  throw new Error(`unexpected version output: ${JSON.stringify(version.stdout)}`);
}

const doctor = run([binary, "doctor", "--format", "json"]);
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
  JSON.stringify(checkIds) !== JSON.stringify(["node-runtime", "sqlite-fts5"])
) {
  throw new Error(`unexpected doctor report: ${doctor.stdout}`);
}

function run(args: readonly string[]): { stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `dist smoke failed (${String(result.status)}): ${result.stderr || result.stdout}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}
