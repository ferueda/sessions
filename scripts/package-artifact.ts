import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isPathWithin } from "./path-containment.ts";
import {
  assertPackagedSkillEntries,
  normalizePackagePath,
  PACKAGED_SKILL_FILES,
  readPackageArchive,
} from "./package-archive.ts";
import { admitPackageArtifactInvocation } from "./package-artifact-cli.ts";

export { PACKAGED_SKILL_FILES } from "./package-archive.ts";

export const PACKAGE_NAME = "@ferueda/sessions";
export const RELEASE_NPM_VERSION = "11.17.0";
const PUBLIC_ROOT_FILES = Object.freeze(["LICENSE", "README.md", "package.json"]);
const INSTALL_LIFECYCLE_SCRIPTS = Object.freeze([
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "preprepare",
  "prepare",
  "postprepare",
]);
const SEMVER_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/u;

export type ReleaseMode = "bootstrap" | "supported";
export type TagPhase = "before" | "after";
export type TagObservation =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly commit: string };

export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly bin: Readonly<Record<string, string>>;
  readonly scripts: Readonly<Record<string, string>>;
}

export interface InspectedPackageArtifact {
  readonly path: string;
  readonly sha256: string;
  readonly files: readonly string[];
  readonly manifest: PackageManifest;
  readText(relativePath: string): string;
}

export interface RoutinePackageArtifact {
  readonly filename: string;
  readonly path: string;
  readonly sha256: string;
  readonly version: string;
  readonly artifact: InspectedPackageArtifact;
}

export interface ReleasePackageArtifact extends RoutinePackageArtifact {
  readonly mode: ReleaseMode;
  readonly tagName: string | null;
}

export interface ReleaseMetadataInput {
  readonly mode: ReleaseMode;
  readonly packageVersion: string;
  readonly manifestVersion: string;
  readonly changelog: string;
}

export interface ReleaseMetadata {
  readonly version: string;
  readonly tagName: string | null;
}

interface PackedFile {
  readonly path: string;
}

interface PackResult {
  readonly filename: string;
  readonly files: readonly PackedFile[];
  readonly name?: string;
  readonly version?: string;
}

interface PackageArtifactOptions {
  readonly root: string;
  readonly outputDirectory: string;
  readonly npmCommand?: string;
}

interface BuildReleasePackageArtifactOptions extends PackageArtifactOptions {
  readonly mode: ReleaseMode;
  readonly releaseSha: string;
  readonly tagPhase: TagPhase;
}

export async function createRoutinePackageArtifact(
  options: PackageArtifactOptions,
): Promise<RoutinePackageArtifact> {
  const before = readCheckoutStatus(options.root);
  try {
    return await packAndInspect(options);
  } finally {
    assertCheckoutUnchanged(before, readCheckoutStatus(options.root));
  }
}

export async function buildReleasePackageArtifact(
  options: BuildReleasePackageArtifactOptions,
): Promise<ReleasePackageArtifact> {
  if (options.tagPhase !== "before") {
    throw new Error("artifact build is allowed only before release creation");
  }
  if (isPathWithin(options.root, path.resolve(options.outputDirectory))) {
    throw new Error("release artifacts must be written outside the source checkout");
  }
  assertExactNpmVersion(options.npmCommand ?? "npm", options.root);
  assertGitSha(options.releaseSha);
  const before = readCheckoutStatus(options.root);
  if (before !== "") {
    throw new Error("release qualification requires a clean checkout");
  }

  try {
    const metadata = await readReleaseMetadata(options.root, options.mode);
    const observation = readLocalTagObservation(
      options.root,
      metadata.tagName ?? `v${metadata.version}`,
    );
    assertReleaseTag({
      mode: options.mode,
      phase: options.tagPhase,
      releaseSha: options.releaseSha,
      tagName: metadata.tagName,
      observation,
    });

    const packed = await packAndInspect(options, metadata.version);
    await assertPublishDryRun({
      npmCommand: options.npmCommand ?? "npm",
      tarball: packed.path,
      expectedVersion: metadata.version,
      expectedFiles: packed.artifact.files,
      tag: options.mode === "bootstrap" ? "bootstrap" : "latest",
    });
    return { ...packed, mode: options.mode, tagName: metadata.tagName };
  } finally {
    assertCheckoutUnchanged(before, readCheckoutStatus(options.root));
  }
}

export async function inspectPackageArtifact(tarball: string): Promise<InspectedPackageArtifact> {
  const archive = await readPackageArchive(tarball);
  const files = archive.files;
  assertPackageInventory(files);
  const manifest = parsePackageManifest(archive.readText("package.json"));
  assertSafePublishedManifest(manifest);
  assertPackagedSkillEntries(archive.entries);

  return Object.freeze({
    path: tarball,
    sha256: archive.sha256,
    files: Object.freeze(files),
    manifest,
    readText(relativePath: string): string {
      return archive.readText(relativePath);
    },
  });
}

export async function assertInstalledPackage(options: {
  readonly installedPackage: string;
  readonly expectedVersion?: string;
  readonly sourceRoot?: string;
  readonly expectedFiles?: readonly string[];
}): Promise<PackageManifest> {
  const files = await relativeFiles(options.installedPackage);
  assertPackageInventory(files);
  if (
    options.expectedFiles !== undefined &&
    !sameStrings(files, [...options.expectedFiles].sort())
  ) {
    throw new Error("installed package files differ from the qualified tarball");
  }

  const manifest = parsePackageManifest(
    await readFile(path.join(options.installedPackage, "package.json"), "utf8"),
  );
  assertSafePublishedManifest(manifest, options.expectedVersion);
  await assertInstalledSkill(options.installedPackage, options.sourceRoot);
  return manifest;
}

export function assertPackageOutsideSource(sourceRoot: string, candidate: string): void {
  if (isPathWithin(sourceRoot, candidate)) {
    throw new Error("installed package resolves into the source checkout");
  }
}

export function assertPackageInventory(files: readonly string[]): void {
  const normalized = files.map(normalizePackagePath).sort();
  if (!sameStrings(normalized, [...new Set(normalized)].sort())) {
    throw new Error("tarball contains duplicate package paths");
  }

  for (const required of [...PUBLIC_ROOT_FILES, "dist/bin/sessions.js"]) {
    if (!normalized.includes(required)) {
      throw new Error(`tarball is missing ${required}`);
    }
  }

  const skillFiles = normalized.filter((file) => file.startsWith("skills/"));
  if (!sameStrings(skillFiles, PACKAGED_SKILL_FILES)) {
    throw new Error(`tarball contains the wrong skill files: ${skillFiles.join(", ")}`);
  }

  for (const file of normalized) {
    const allowedRoot = PUBLIC_ROOT_FILES.includes(file);
    const allowedSkill = PACKAGED_SKILL_FILES.includes(file);
    const allowedCompiled =
      file.startsWith("dist/") && (file.endsWith(".js") || file.endsWith(".js.map"));
    if (!allowedRoot && !allowedSkill && !allowedCompiled) {
      throw new Error(`tarball contains an unexpected file: ${file}`);
    }
  }
}

export function parsePackageManifest(source: string): PackageManifest {
  const value = JSON.parse(source) as unknown;
  if (!isRecord(value)) throw new Error("package manifest must be an object");
  if (typeof value.name !== "string" || typeof value.version !== "string") {
    throw new Error("package manifest must declare name and version");
  }
  if (!isStringRecord(value.bin)) throw new Error("package manifest must declare a bin map");
  const scripts = value.scripts === undefined ? {} : value.scripts;
  if (!isStringRecord(scripts)) throw new Error("package manifest scripts must be strings");
  return Object.freeze({
    name: value.name,
    version: value.version,
    bin: Object.freeze({ ...value.bin }),
    scripts: Object.freeze({ ...scripts }),
  });
}

export function assertSafePublishedManifest(
  manifest: PackageManifest,
  expectedVersion?: string,
): void {
  if (manifest.name !== PACKAGE_NAME) {
    throw new Error(`unexpected package name: ${manifest.name}`);
  }
  assertSemver(manifest.version);
  if (expectedVersion !== undefined && manifest.version !== expectedVersion) {
    throw new Error(
      `package version ${manifest.version} does not match expected ${expectedVersion}`,
    );
  }
  if (Object.keys(manifest.bin).length !== 1 || manifest.bin.sessions !== "dist/bin/sessions.js") {
    throw new Error("published manifest must keep the sessions executable mapping");
  }
  const installScripts = INSTALL_LIFECYCLE_SCRIPTS.filter(
    (name) => manifest.scripts[name] !== undefined,
  );
  if (installScripts.length > 0) {
    throw new Error(`published manifest contains install lifecycle scripts: ${installScripts}`);
  }
}

export function assertReleaseMetadata(input: ReleaseMetadataInput): ReleaseMetadata {
  assertSemver(input.packageVersion);
  assertSemver(input.manifestVersion);
  if (input.packageVersion !== input.manifestVersion) {
    throw new Error("package and release manifest versions differ");
  }

  if (input.mode === "bootstrap") {
    if (input.packageVersion !== "0.0.0") {
      throw new Error("bootstrap qualification requires version 0.0.0");
    }
    if (releasedChangelogVersions(input.changelog).length > 0) {
      throw new Error("bootstrap qualification rejects supported changelog releases");
    }
    return Object.freeze({ version: "0.0.0", tagName: null });
  }

  if (!isSupportedVersion(input.packageVersion)) {
    throw new Error("supported release qualification requires version 0.1.0 or newer");
  }
  if (!releasedChangelogVersions(input.changelog).includes(input.packageVersion)) {
    throw new Error(`changelog has no release for ${input.packageVersion}`);
  }
  return Object.freeze({
    version: input.packageVersion,
    tagName: `v${input.packageVersion}`,
  });
}

export function assertReleaseTag(options: {
  readonly mode: ReleaseMode;
  readonly phase: TagPhase;
  readonly releaseSha: string;
  readonly tagName: string | null;
  readonly observation: TagObservation;
}): void {
  assertGitSha(options.releaseSha);
  if (options.mode === "bootstrap") {
    if (options.phase !== "before" || options.tagName !== null) {
      throw new Error("bootstrap qualification cannot create or require a Git tag");
    }
    if (options.observation.kind !== "absent") {
      throw new Error("bootstrap qualification rejects a v0.0.0 Git tag");
    }
    return;
  }
  if (options.tagName === null) throw new Error("supported release requires an expected tag");

  if (options.observation.kind === "absent") {
    if (options.phase === "after") {
      throw new Error(`release tag ${options.tagName} is absent after release creation`);
    }
    return;
  }
  if (options.observation.commit !== options.releaseSha) {
    throw new Error(`release tag ${options.tagName} points to a conflicting commit`);
  }
}

export function assertArtifactDigest(actual: string, expected: string): void {
  if (!SHA256_PATTERN.test(expected)) {
    throw new Error("expected artifact SHA-256 must be 64 lowercase hex characters");
  }
  if (actual !== expected) throw new Error("package artifact SHA-256 does not match");
}

export function assertNpmOutputHasNoCorrections(result: CommandResult, operation: string): void {
  const output = `${result.stdout}\n${result.stderr}`;
  if (/auto-correct|npm pkg fix|invalid bin|corrected package|manifest correction/iu.test(output)) {
    throw new Error(`${operation} reported a package-manifest correction`);
  }
}

export function assertInstallOutputHasNoWarnings(result: CommandResult, operation: string): void {
  assertNpmOutputHasNoCorrections(result, operation);
  if (/(?:^|\n)\s*npm warn|lifecycle script/iu.test(`${result.stdout}\n${result.stderr}`)) {
    throw new Error(`${operation} reported an npm or lifecycle warning`);
  }
}

export function assertCheckoutUnchanged(before: string, after: string): void {
  if (before !== after) throw new Error("package qualification changed the source checkout");
}

export function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: environment,
    shell:
      process.platform === "win32" &&
      (command.endsWith(".cmd") || /(?:^|[\\/])(?:npm|npx|pnpm)$/u.test(command)),
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function assertCommandSucceeded(result: CommandResult, operation: string): void {
  if (result.status !== 0) {
    throw new Error(
      `${operation} failed (${String(result.status)}): ${result.stderr || result.stdout}`,
    );
  }
}

export function readCheckoutStatus(root: string): string {
  const result = runCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"], root);
  assertCommandSucceeded(result, "git status");
  return result.stdout;
}

export function readLocalTagObservation(root: string, tagName: string): TagObservation {
  const reference = `refs/tags/${tagName}^{commit}`;
  const result = runCommand("git", ["rev-parse", "--verify", "--quiet", reference], root);
  if (result.status === 1) return { kind: "absent" };
  assertCommandSucceeded(result, `git tag lookup for ${tagName}`);
  const commit = result.stdout.trim();
  assertGitSha(commit);
  return { kind: "present", commit };
}

export async function verifyReleaseTag(options: {
  readonly root: string;
  readonly version: string;
  readonly releaseSha: string;
  readonly tagPhase: TagPhase;
}): Promise<void> {
  assertSemver(options.version);
  const tagName = `v${options.version}`;
  assertReleaseTag({
    mode: "supported",
    phase: options.tagPhase,
    releaseSha: options.releaseSha,
    tagName,
    observation: readLocalTagObservation(options.root, tagName),
  });
}

async function packAndInspect(
  options: PackageArtifactOptions,
  expectedVersion?: string,
): Promise<RoutinePackageArtifact> {
  await mkdir(options.outputDirectory, { recursive: true });
  const result = runCommand(
    options.npmCommand ?? "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", options.outputDirectory],
    options.root,
  );
  assertCommandSucceeded(result, "npm pack");
  assertNpmOutputHasNoCorrections(result, "npm pack");
  const packed = parsePackResult(result.stdout);
  const tarball = path.resolve(options.outputDirectory, packed.filename);
  const artifact = await inspectPackageArtifact(tarball);
  assertSafePublishedManifest(artifact.manifest, expectedVersion);
  const reportedFiles = packed.files.map((file) => normalizePackagePath(file.path)).sort();
  if (!sameStrings(reportedFiles, artifact.files)) {
    throw new Error("npm pack inventory differs from the tarball inventory");
  }
  if (packed.name !== undefined && packed.name !== artifact.manifest.name) {
    throw new Error("npm pack reported an unexpected package name");
  }
  if (packed.version !== undefined && packed.version !== artifact.manifest.version) {
    throw new Error("npm pack reported an unexpected package version");
  }
  return Object.freeze({
    filename: packed.filename,
    path: tarball,
    sha256: artifact.sha256,
    version: artifact.manifest.version,
    artifact,
  });
}

async function readReleaseMetadata(root: string, mode: ReleaseMode): Promise<ReleaseMetadata> {
  const [packageSource, manifestSource, changelog] = await Promise.all([
    readFile(path.join(root, "package.json"), "utf8"),
    readFile(path.join(root, ".release-please-manifest.json"), "utf8"),
    readFile(path.join(root, "CHANGELOG.md"), "utf8"),
  ]);
  const packageManifest = parsePackageManifest(packageSource);
  const manifest = JSON.parse(manifestSource) as unknown;
  if (!isRecord(manifest) || typeof manifest["."] !== "string") {
    throw new Error("release manifest must declare the root package version");
  }
  return assertReleaseMetadata({
    mode,
    packageVersion: packageManifest.version,
    manifestVersion: manifest["."],
    changelog,
  });
}

async function assertPublishDryRun(options: {
  readonly npmCommand: string;
  readonly tarball: string;
  readonly expectedVersion: string;
  readonly expectedFiles: readonly string[];
  readonly tag: "bootstrap" | "latest";
}): Promise<void> {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "sessions-publish-dry-run-"));
  try {
    const stagedTarball = path.join(temporaryRoot, path.basename(options.tarball));
    await cp(options.tarball, stagedTarball);
    const result = runCommand(
      options.npmCommand,
      [
        "publish",
        stagedTarball,
        "--dry-run",
        "--json",
        "--ignore-scripts",
        "--provenance=false",
        "--access",
        "public",
        "--tag",
        options.tag,
      ],
      temporaryRoot,
      isolatedNpmEnvironment(temporaryRoot),
    );
    assertCommandSucceeded(result, "npm publish --dry-run");
    assertNpmOutputHasNoCorrections(result, "npm publish --dry-run");
    const report = JSON.parse(result.stdout) as unknown;
    const packageReport = isRecord(report) ? report[PACKAGE_NAME] : undefined;
    if (
      !isRecord(packageReport) ||
      packageReport.name !== PACKAGE_NAME ||
      packageReport.version !== options.expectedVersion ||
      !Array.isArray(packageReport.files)
    ) {
      throw new Error("npm publish --dry-run returned an invalid report");
    }
    const files = packageReport.files.map((file) => {
      if (!isRecord(file) || typeof file.path !== "string") {
        throw new Error("npm publish --dry-run reported an invalid file");
      }
      return normalizePackagePath(file.path);
    });
    if (!sameStrings(files.sort(), [...options.expectedFiles].sort())) {
      throw new Error("npm publish --dry-run inventory differs from the qualified tarball");
    }
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

export function assertExactNpmVersion(command: string, root: string): void {
  const result = runCommand(command, ["--version"], root);
  assertCommandSucceeded(result, "npm --version");
  if (result.stderr !== "" || result.stdout.trim() !== RELEASE_NPM_VERSION) {
    throw new Error(`release qualification requires npm ${RELEASE_NPM_VERSION}`);
  }
}

function parsePackResult(source: string): PackResult {
  const value = JSON.parse(source) as unknown;
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) {
    throw new Error("npm pack returned an invalid report");
  }
  const report = value[0];
  if (typeof report.filename !== "string" || !Array.isArray(report.files)) {
    throw new Error("npm pack report has no filename or file inventory");
  }
  const files = report.files.map((file) => {
    if (!isRecord(file) || typeof file.path !== "string") {
      throw new Error("npm pack reported an invalid file");
    }
    return { path: file.path };
  });
  return {
    filename: report.filename,
    files,
    ...(typeof report.name === "string" ? { name: report.name } : {}),
    ...(typeof report.version === "string" ? { version: report.version } : {}),
  };
}

async function assertInstalledSkill(installedPackage: string, sourceRoot?: string): Promise<void> {
  const skillRoot = path.join(installedPackage, "skills", "sessions");
  if (sourceRoot !== undefined) {
    for (const relativeFile of PACKAGED_SKILL_FILES) {
      const [source, installed] = await Promise.all([
        readFile(path.join(sourceRoot, relativeFile)),
        readFile(path.join(installedPackage, relativeFile)),
      ]);
      if (!source.equals(installed)) {
        throw new Error(`installed skill differs at ${relativeFile}`);
      }
    }
  }
  const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
  const metadata = await readFile(path.join(skillRoot, "agents", "openai.yaml"), "utf8");
  const entries = new Map<string, Buffer>();
  for (const relativeFile of PACKAGED_SKILL_FILES) {
    entries.set(relativeFile, await readFile(path.join(installedPackage, relativeFile)));
  }
  entries.set("skills/sessions/SKILL.md", Buffer.from(skill));
  entries.set("skills/sessions/agents/openai.yaml", Buffer.from(metadata));
  assertPackagedSkillEntries(entries);
}

async function relativeFiles(root: string, relativeRoot = ""): Promise<string[]> {
  const directory = path.join(root, relativeRoot);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = relativeRoot === "" ? entry.name : `${relativeRoot}/${entry.name}`;
    // Package managers may materialize dependency links after extracting the exact archive.
    if (relativePath === "node_modules") continue;
    const absolutePath = path.join(root, relativePath);
    if (entry.isDirectory()) {
      files.push(...(await relativeFiles(root, relativePath)));
    } else {
      const status = await lstat(absolutePath);
      if (!status.isFile())
        throw new Error(`installed package contains a non-file: ${relativePath}`);
      files.push(relativePath.replaceAll(path.sep, "/"));
    }
  }
  return files.sort();
}

function releasedChangelogVersions(changelog: string): string[] {
  const versions: string[] = [];
  for (const line of changelog.split(/\r?\n/u)) {
    const match = /^## (?:\[)?(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)(?:\]|\s|$)/u.exec(line);
    const version = match?.groups?.version;
    if (version !== undefined) versions.push(version);
  }
  return versions;
}

function assertSemver(version: string): void {
  if (!SEMVER_PATTERN.test(version)) throw new Error(`invalid package version: ${version}`);
}

function isSupportedVersion(version: string): boolean {
  if (version.includes("-")) return false;
  const [major, minor] = version.split(".").map(Number);
  return (major ?? 0) > 0 || ((major ?? 0) === 0 && (minor ?? 0) >= 1);
}

function assertGitSha(sha: string): void {
  if (!GIT_SHA_PATTERN.test(sha))
    throw new Error("release SHA must be 40 lowercase hex characters");
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isolatedNpmEnvironment(temporaryRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: temporaryRoot,
    USERPROFILE: temporaryRoot,
    npm_config_cache: path.join(temporaryRoot, "npm-cache"),
    npm_config_update_notifier: "false",
  };
}

async function main(): Promise<void> {
  const invocation = admitPackageArtifactInvocation(process.argv.slice(2));
  const root = path.resolve(import.meta.dirname, "..");
  if (invocation.command === "verify-tag") {
    await verifyReleaseTag({
      root,
      version: invocation.version,
      releaseSha: invocation.releaseSha,
      tagPhase: invocation.tagPhase,
    });
    return;
  }
  const result = await buildReleasePackageArtifact({
    root,
    outputDirectory: path.resolve(invocation.outputDirectory),
    mode: invocation.mode,
    releaseSha: invocation.releaseSha,
    tagPhase: invocation.tagPhase,
  });
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      mode: result.mode,
      version: result.version,
      tagName: result.tagName,
      filename: result.filename,
      tarballPath: result.path,
      sha256: result.sha256,
    })}\n`,
  );
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `sessions package artifact: ${error instanceof Error ? error.message : "unexpected failure"}\n`,
    );
    process.exitCode = 1;
  }
}
