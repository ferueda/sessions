import { spawnSync } from "node:child_process";
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
  await mkdir(project);
  await writeFile(
    path.join(project, "package.json"),
    `${JSON.stringify({ name: "sessions-package-smoke", private: true }, null, 2)}\n`,
  );

  const tarball = path.join(temporaryRoot, packed.filename);
  runPackageManager("pnpm", ["add", "--offline", "--ignore-scripts", tarball], project);

  const help = runPackageManager("pnpm", ["exec", "sessions", "--help"], project);
  if (!help.stdout.includes("Usage: sessions") || help.stderr !== "") {
    throw new Error(`installed binary returned invalid help: ${JSON.stringify(help)}`);
  }

  const version = runPackageManager("pnpm", ["exec", "sessions", "--version"], project);
  if (!/^\d+\.\d+\.\d+\s*$/u.test(version.stdout)) {
    throw new Error(`installed binary returned an invalid version: ${version.stdout}`);
  }

  const doctor = runPackageManager(
    "pnpm",
    ["exec", "sessions", "doctor", "--format", "json"],
    project,
  );
  const report = JSON.parse(doctor.stdout) as { schemaVersion?: unknown; ok?: unknown };
  if (report.schemaVersion !== 1 || report.ok !== true) {
    throw new Error(`installed binary returned an invalid doctor report: ${doctor.stdout}`);
  }
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  shell = false,
): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell });
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
): { stdout: string; stderr: string } {
  // npm and pnpm are .cmd shims on Windows; Node requires a command shell for them.
  return run(command, args, cwd, process.platform === "win32");
}
