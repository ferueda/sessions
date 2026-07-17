import { existsSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertCommandSucceeded,
  assertInstalledPackage,
  assertPackageOutsideSource,
  createRoutinePackageArtifact,
  runCommand,
} from "./package-artifact.ts";
import { runSmokeWorkflow } from "./smoke-workflow.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "sessions-package-"));

try {
  const packed = await createRoutinePackageArtifact({
    root,
    outputDirectory: temporaryRoot,
  });
  const project = path.join(temporaryRoot, "project");
  await mkdir(project);
  await writeFile(
    path.join(project, "package.json"),
    `${JSON.stringify({ name: "sessions-package-smoke", private: true }, null, 2)}\n`,
  );

  const storeResult = runPackageManager("pnpm", ["store", "path", "--silent"], root);
  const store = storeResult.stdout.trim();
  if (store.length === 0) throw new Error("pnpm store path returned no path");
  runPackageManager(
    "pnpm",
    ["add", "--offline", "--ignore-scripts", "--store-dir", store, packed.path],
    project,
  );

  const installedPackage = path.join(project, "node_modules", "@ferueda", "sessions");
  const installedBinary = path.join(installedPackage, "dist", "bin", "sessions.js");
  if (!existsSync(installedBinary)) throw new Error("offline install has no sessions binary");
  assertPackageOutsideSource(root, await realpath(installedBinary));
  assertPackageOutsideSource(
    root,
    await realpath(path.join(installedPackage, "skills", "sessions")),
  );
  await assertInstalledPackage({
    installedPackage,
    expectedVersion: packed.version,
    sourceRoot: root,
    expectedFiles: packed.artifact.files,
  });

  const help = runCommand(process.execPath, [installedBinary, "--help"], project);
  if (help.status !== 0 || !help.stdout.includes("Usage: sessions") || help.stderr !== "") {
    throw new Error(`installed binary returned invalid help: ${JSON.stringify(help)}`);
  }

  const version = runCommand(process.execPath, [installedBinary, "--version"], project);
  if (version.status !== 0 || version.stdout.trim() !== packed.version || version.stderr !== "") {
    throw new Error(`installed binary returned an invalid version: ${version.stdout}`);
  }

  await runSmokeWorkflow({
    temporaryRoot,
    moduleRoot: path.join(installedPackage, "dist"),
    run: (args, environment) =>
      runCommand(process.execPath, [installedBinary, ...args], project, environment),
  });
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}

function runPackageManager(
  command: "pnpm",
  args: readonly string[],
  cwd: string,
): { readonly stdout: string; readonly stderr: string } {
  const result = runCommand(command, args, cwd);
  assertCommandSucceeded(result, `${command} ${args.join(" ")}`);
  return result;
}
