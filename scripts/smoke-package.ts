import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isPathWithin } from "./path-containment.ts";
import { runSmokeWorkflow } from "./smoke-workflow.ts";

interface PackedFile {
  readonly path: string;
}

interface PackResult {
  readonly filename: string;
  readonly files: readonly PackedFile[];
}

const root = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "sessions-package-"));
const skillFiles = [
  "skills/sessions/SKILL.md",
  "skills/sessions/agents/openai.yaml",
  "skills/sessions/references/evidence-protocol.md",
  "skills/sessions/references/search-and-context.md",
  "skills/sessions/references/retrospective.md",
  "skills/sessions/references/preferences.md",
  "skills/sessions/references/workflow-audit.md",
  "skills/sessions/references/verification-audit.md",
  "skills/sessions/references/handoff-continuity.md",
  "skills/sessions/references/capability-discovery.md",
].sort();

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
  const packedSkillFiles = paths.filter((file) => file.startsWith("skills/")).sort();
  if (JSON.stringify(packedSkillFiles) !== JSON.stringify(skillFiles)) {
    throw new Error(`tarball contains the wrong skill files: ${packedSkillFiles.join(", ")}`);
  }

  const project = path.join(temporaryRoot, "project");
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

  const installedBinary = path.join(
    project,
    "node_modules",
    "@ferueda",
    "sessions",
    "dist",
    "bin",
    "sessions.js",
  );
  if (!existsSync(installedBinary)) throw new Error("offline install has no sessions binary");
  const installedTarget = await realpath(installedBinary);
  if (isPathWithin(root, installedTarget)) {
    throw new Error("offline install resolves its binary into the source checkout");
  }

  const installedPackage = path.join(project, "node_modules", "@ferueda", "sessions");
  const installedSkill = path.join(installedPackage, "skills", "sessions");
  const installedSkillTarget = await realpath(installedSkill);
  if (isPathWithin(root, installedSkillTarget)) {
    throw new Error("offline install resolves its skill into the source checkout");
  }
  await assertInstalledSkill(installedPackage);

  const help = run(process.execPath, [installedBinary, "--help"], project);
  if (help.status !== 0 || !help.stdout.includes("Usage: sessions") || help.stderr !== "") {
    throw new Error(`installed binary returned invalid help: ${JSON.stringify(help)}`);
  }

  const version = run(process.execPath, [installedBinary, "--version"], project);
  if (version.status !== 0 || !/^\d+\.\d+\.\d+\s*$/u.test(version.stdout)) {
    throw new Error(`installed binary returned an invalid version: ${version.stdout}`);
  }

  await runSmokeWorkflow({
    temporaryRoot,
    moduleRoot: path.join(installedPackage, "dist"),
    run: (args, environment) =>
      run(process.execPath, [installedBinary, ...args], project, false, environment),
  });
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}

async function assertInstalledSkill(installedPackage: string): Promise<void> {
  for (const relativeFile of skillFiles) {
    const [source, installed] = await Promise.all([
      readFile(path.join(root, relativeFile), "utf8"),
      readFile(path.join(installedPackage, relativeFile), "utf8"),
    ]);
    if (installed !== source) throw new Error(`installed skill differs at ${relativeFile}`);
  }

  const skillRoot = path.join(installedPackage, "skills", "sessions");
  const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
  const metadata = await readFile(path.join(skillRoot, "agents", "openai.yaml"), "utf8");
  if (!/^---\n[\s\S]*?^name: sessions$[\s\S]*?^description: .+$[\s\S]*?^---$/mu.test(skill)) {
    throw new Error("installed Sessions skill has invalid frontmatter");
  }
  if (!metadata.startsWith("interface:\n") || !/default_prompt: ".*\$sessions.*"/u.test(metadata)) {
    throw new Error("installed Sessions skill has invalid interface metadata");
  }

  for (const match of skill.matchAll(/\[[^\]]+\]\((references\/[^)]+)\)/gu)) {
    const target = match[1];
    if (target === undefined || !existsSync(path.join(skillRoot, target))) {
      throw new Error(`installed Sessions skill has an unresolved reference: ${String(target)}`);
    }
  }
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  shell = false,
  env: NodeJS.ProcessEnv = process.env,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env, shell });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runPackageManager(
  command: "npm" | "pnpm",
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): { stdout: string; stderr: string } {
  // npm and pnpm are .cmd shims on Windows; Node requires a command shell for them.
  const result = run(command, args, cwd, process.platform === "win32", env);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${String(result.status)}): ${result.stderr || result.stdout}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}
