import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertArtifactDigest,
  assertCheckoutUnchanged,
  assertCommandSucceeded,
  assertExactNpmVersion,
  assertInstalledPackage,
  assertInstallOutputHasNoWarnings,
  assertPackageOutsideSource,
  inspectPackageArtifact,
  readCheckoutStatus,
  runCommand,
} from "./package-artifact.ts";
import { runSmokeWorkflow } from "./smoke-workflow.ts";

interface Invocation {
  readonly tarball: string;
  readonly sha256: string;
  readonly version: string;
}

const root = fileURLToPath(new URL("..", import.meta.url));

async function main(): Promise<void> {
  const invocation = admitInvocation(process.argv.slice(2));
  const checkoutBefore = readCheckoutStatus(root);
  if (checkoutBefore !== "") throw new Error("release package smoke requires a clean checkout");
  assertExactNpmVersion("npm", root);

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "sessions-release-package-"));
  try {
    const tarball = path.resolve(invocation.tarball);
    const artifact = await inspectPackageArtifact(tarball);
    assertArtifactDigest(artifact.sha256, invocation.sha256);
    if (artifact.manifest.version !== invocation.version) {
      throw new Error("qualified artifact version differs from the expected release version");
    }

    const environment = isolatedEnvironment(temporaryRoot);
    const prefix = path.join(temporaryRoot, "global");
    const install = runCommand(
      "npm",
      [
        "install",
        "--global",
        "--prefix",
        prefix,
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        tarball,
      ],
      temporaryRoot,
      environment,
    );
    assertCommandSucceeded(install, "ordinary npm global install");
    assertInstallOutputHasNoWarnings(install, "ordinary npm global install");

    const installedPackage = locateInstalledPackage(prefix);
    const installedBinary = path.join(installedPackage, "dist", "bin", "sessions.js");
    const shim = locateInstalledShim(prefix);
    assertPackageOutsideSource(root, await realpath(installedBinary));
    await assertInstalledPackage({
      installedPackage,
      expectedVersion: invocation.version,
      sourceRoot: root,
      expectedFiles: artifact.files,
    });

    assertCliResult(runCommand(shim, ["--help"], temporaryRoot, environment), {
      operation: "global sessions --help",
      output: "Usage: sessions",
    });
    assertCliResult(runCommand(shim, ["--version"], temporaryRoot, environment), {
      operation: "global sessions --version",
      output: invocation.version,
      exact: true,
    });

    const npx = runCommand(
      "npx",
      ["--yes", "--package", pathToFileURL(tarball).href, "sessions", "--version"],
      temporaryRoot,
      environment,
    );
    assertCommandSucceeded(npx, "isolated npx trial");
    assertInstallOutputHasNoWarnings(npx, "isolated npx trial");
    if (npx.stderr !== "" || npx.stdout.trim() !== invocation.version) {
      throw new Error("isolated npx trial returned the wrong version");
    }

    await runSmokeWorkflow({
      temporaryRoot,
      moduleRoot: path.join(installedPackage, "dist"),
      run: (args, commandEnvironment) =>
        runCommand(shim, args, temporaryRoot, {
          ...environment,
          ...commandEnvironment,
        }),
    });
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
    assertCheckoutUnchanged(checkoutBefore, readCheckoutStatus(root));
  }
}

function admitInvocation(argv: readonly string[]): Invocation {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === undefined || value === undefined || !option.startsWith("--")) {
      throw new TypeError("release package smoke options require --name value pairs");
    }
    if (values.has(option)) throw new TypeError(`duplicate option ${option}`);
    values.set(option, value);
  }
  const unexpected = [...values.keys()].filter(
    (option) => !["--tarball", "--sha256", "--version"].includes(option),
  );
  if (unexpected.length > 0) throw new TypeError(`unknown option ${unexpected[0]}`);
  return {
    tarball: requireValue(values, "--tarball"),
    sha256: requireValue(values, "--sha256"),
    version: requireValue(values, "--version"),
  };
}

function requireValue(values: ReadonlyMap<string, string>, option: string): string {
  const value = values.get(option);
  if (value === undefined || value === "") throw new TypeError(`missing ${option}`);
  return value;
}

function locateInstalledPackage(prefix: string): string {
  const candidates =
    process.platform === "win32"
      ? [path.join(prefix, "node_modules", "@ferueda", "sessions")]
      : [path.join(prefix, "lib", "node_modules", "@ferueda", "sessions")];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) throw new Error("global install has no Sessions package");
  return found;
}

function locateInstalledShim(prefix: string): string {
  const candidate =
    process.platform === "win32"
      ? path.join(prefix, "sessions.cmd")
      : path.join(prefix, "bin", "sessions");
  if (!existsSync(candidate)) throw new Error("global install has no sessions shim");
  return candidate;
}

function isolatedEnvironment(temporaryRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: temporaryRoot,
    USERPROFILE: temporaryRoot,
    npm_config_cache: path.join(temporaryRoot, "npm-cache"),
    npm_config_update_notifier: "false",
  };
}

function assertCliResult(
  result: ReturnType<typeof runCommand>,
  expected: {
    readonly operation: string;
    readonly output: string;
    readonly exact?: boolean;
  },
): void {
  assertCommandSucceeded(result, expected.operation);
  if (result.stderr !== "") throw new Error(`${expected.operation} wrote to stderr`);
  const matches = expected.exact
    ? result.stdout.trim() === expected.output
    : result.stdout.includes(expected.output);
  if (!matches) throw new Error(`${expected.operation} returned unexpected output`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `sessions release package smoke: ${error instanceof Error ? error.message : "unexpected failure"}\n`,
  );
  process.exitCode = 1;
}
