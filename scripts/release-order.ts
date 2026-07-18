import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BOOTSTRAP_VERSION = "0.0.0";
const FIRST_SUPPORTED_VERSION = "0.1.0";
const EXPECTED_PACKAGE = "@ferueda/sessions";
const EXPECTED_REPOSITORY = "git+https://github.com/ferueda/sessions.git";
const EXPECTED_ENGINE = ">=24.16.0";
const EXPECTED_BIN = "dist/bin/sessions.js";

interface ParsedSemver {
  readonly major: bigint;
  readonly minor: bigint;
  readonly patch: bigint;
  readonly prerelease: readonly string[];
}

export interface ReleaseRouteInput {
  readonly eventName: "push" | "workflow_dispatch";
  readonly ref: string;
  readonly bootstrapRequested: boolean;
  readonly retryReleaseRequested?: boolean;
  readonly previousManifestVersion: string | null;
  readonly currentManifestVersion: string;
  readonly packageVersion: string;
  readonly changelog: string;
}

export interface ReleaseRoute {
  readonly qualify: boolean;
  readonly releaseTarget: boolean;
  readonly mode: "bootstrap" | "supported" | "none";
  readonly version: string;
  readonly parentVersion: string;
  readonly reason:
    | "bootstrap-qualification"
    | "manifest-seed"
    | "release-retry"
    | "release-target"
    | "no-change";
}

export interface RegistryReleaseState {
  readonly latestVersion: string | null;
  readonly bootstrapVersion: string | null;
  readonly targetIntegrity: string | null;
}

export interface ReleaseOrderInput extends RegistryReleaseState {
  readonly parentVersion: string;
  readonly targetVersion: string;
  readonly qualifiedIntegrity: string;
}

export type ReleaseOrderDecision =
  | { readonly action: "publish" }
  | { readonly action: "verify" }
  | { readonly action: "stale-verify"; readonly latestVersion: string };

export function classifyReleaseRoute(input: ReleaseRouteInput): ReleaseRoute {
  assertVersion(input.currentManifestVersion, "current manifest version");
  assertVersion(input.packageVersion, "package version");
  if (input.currentManifestVersion !== input.packageVersion) {
    throw new Error("package and release manifest versions do not match");
  }

  if (input.eventName === "workflow_dispatch") {
    if (input.ref !== "refs/heads/main") {
      throw new Error("manual release operations must select the main branch");
    }
    if (input.retryReleaseRequested === true) {
      if (input.bootstrapRequested) {
        throw new Error("bootstrap qualification and supported-release retry are exclusive");
      }
      if (input.previousManifestVersion === null) {
        throw new Error("supported-release retry requires a parent release manifest");
      }
      assertVersion(input.previousManifestVersion, "parent manifest version");
      if (compareVersions(input.currentManifestVersion, input.previousManifestVersion) <= 0) {
        throw new Error("release manifest versions must increase");
      }
      if (compareVersions(input.currentManifestVersion, FIRST_SUPPORTED_VERSION) < 0) {
        throw new Error("supported releases must be at least version 0.1.0");
      }
      if (!hasChangelogRelease(input.changelog, input.currentManifestVersion)) {
        throw new Error("the target version is missing from CHANGELOG.md");
      }
      return {
        qualify: false,
        releaseTarget: true,
        mode: "supported",
        version: input.currentManifestVersion,
        parentVersion: input.previousManifestVersion,
        reason: "release-retry",
      };
    }
    if (!input.bootstrapRequested) {
      throw new Error("manual release operation requires bootstrap or retry-release");
    }
    if (input.currentManifestVersion !== BOOTSTRAP_VERSION) {
      throw new Error("manual qualification is limited to the 0.0.0 bootstrap seed");
    }
    if (hasChangelogRelease(input.changelog, BOOTSTRAP_VERSION)) {
      throw new Error("the unsupported bootstrap seed cannot be a changelog release");
    }
    return {
      qualify: true,
      releaseTarget: false,
      mode: "bootstrap",
      version: BOOTSTRAP_VERSION,
      parentVersion: "",
      reason: "bootstrap-qualification",
    };
  }

  if (input.previousManifestVersion === null) {
    if (input.currentManifestVersion !== BOOTSTRAP_VERSION) {
      throw new Error("the initial release manifest must seed version 0.0.0");
    }
    return {
      qualify: false,
      releaseTarget: false,
      mode: "none",
      version: BOOTSTRAP_VERSION,
      parentVersion: "",
      reason: "manifest-seed",
    };
  }

  assertVersion(input.previousManifestVersion, "parent manifest version");
  if (input.previousManifestVersion === input.currentManifestVersion) {
    return {
      qualify: false,
      releaseTarget: false,
      mode: "none",
      version: input.currentManifestVersion,
      parentVersion: input.previousManifestVersion,
      reason: "no-change",
    };
  }

  if (compareVersions(input.currentManifestVersion, input.previousManifestVersion) <= 0) {
    throw new Error("release manifest versions must increase");
  }
  if (compareVersions(input.currentManifestVersion, FIRST_SUPPORTED_VERSION) < 0) {
    throw new Error("supported releases must be at least version 0.1.0");
  }
  if (!hasChangelogRelease(input.changelog, input.currentManifestVersion)) {
    throw new Error("the target version is missing from CHANGELOG.md");
  }

  return {
    qualify: true,
    releaseTarget: true,
    mode: "supported",
    version: input.currentManifestVersion,
    parentVersion: input.previousManifestVersion,
    reason: "release-target",
  };
}

export function decideReleaseOrder(input: ReleaseOrderInput): ReleaseOrderDecision {
  assertVersion(input.parentVersion, "parent version");
  assertVersion(input.targetVersion, "target version");
  assertIntegrity(input.qualifiedIntegrity, "qualified artifact integrity");
  if (compareVersions(input.targetVersion, input.parentVersion) <= 0) {
    throw new Error("target version must be newer than its parent");
  }

  if (input.targetIntegrity !== null) {
    assertIntegrity(input.targetIntegrity, "registry target integrity");
    if (input.targetIntegrity !== input.qualifiedIntegrity) {
      throw new Error("published target integrity conflicts with the qualified artifact");
    }
    if (input.latestVersion === input.targetVersion) return { action: "verify" };
    if (
      input.latestVersion !== null &&
      compareVersions(input.latestVersion, input.targetVersion) > 0
    ) {
      return { action: "stale-verify", latestVersion: input.latestVersion };
    }
    throw new Error("published target does not have a valid latest-tag state");
  }

  if (input.parentVersion === BOOTSTRAP_VERSION) {
    if (
      input.targetVersion !== FIRST_SUPPORTED_VERSION ||
      (input.latestVersion !== null && input.latestVersion !== BOOTSTRAP_VERSION) ||
      input.bootstrapVersion !== BOOTSTRAP_VERSION
    ) {
      throw new Error(
        "first supported release requires the bootstrap seed, latest absent or on the seed, and target 0.1.0",
      );
    }
    return { action: "publish" };
  }

  if (input.latestVersion === input.parentVersion) return { action: "publish" };
  if (input.latestVersion === null) {
    throw new Error("registry latest is missing for a non-bootstrap release");
  }
  if (compareVersions(input.latestVersion, input.targetVersion) > 0) {
    throw new Error("target is absent while registry latest is newer");
  }
  throw new Error("registry latest does not match the release parent");
}

export function computeArtifactIntegrity(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

export function computeArtifactSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] < b[key]) return -1;
    if (a[key] > b[key]) return 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const count = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const leftIdentifier = a.prerelease[index];
    const rightIdentifier = b.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = isNumericIdentifier(leftIdentifier);
    const rightNumeric = isNumericIdentifier(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftIdentifier) < BigInt(rightIdentifier) ? -1 : 1;
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

function parseVersion(value: string): ParsedSemver {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    );
  if (match === null) throw new Error(`invalid SemVer: ${value}`);
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => isNumericIdentifier(part) && part.length > 1 && part[0] === "0")) {
    throw new Error(`invalid SemVer prerelease: ${value}`);
  }
  return {
    major: BigInt(match[1] ?? ""),
    minor: BigInt(match[2] ?? ""),
    patch: BigInt(match[3] ?? ""),
    prerelease,
  };
}

function assertVersion(value: string, label: string): void {
  try {
    parseVersion(value);
  } catch {
    throw new Error(`${label} is not valid SemVer`);
  }
}

function assertIntegrity(value: string, label: string): void {
  const encoded = value.startsWith("sha512-") ? value.slice("sha512-".length) : "";
  const decoded = Buffer.from(encoded, "base64");
  if (
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
    decoded.length !== 64 ||
    decoded.toString("base64") !== encoded
  ) {
    throw new Error(`${label} is not a sha512 integrity value`);
  }
}

function isNumericIdentifier(value: string): boolean {
  return /^\d+$/.test(value);
}

function hasChangelogRelease(changelog: string, version: string): boolean {
  const escaped = version.replaceAll(".", String.raw`\.`);
  return new RegExp(String.raw`^## (?:\[${escaped}\](?:\(|\s|$)|${escaped}(?:\s|$))`, "m").test(
    changelog,
  );
}

function readRegistryState(packageName: string, targetVersion: string): RegistryReleaseState {
  const tags = npmView<Record<string, unknown>>([packageName, "dist-tags"]) ?? {};
  const targetIntegrity = npmView<string>(
    [`${packageName}@${targetVersion}`, "dist.integrity"],
    true,
  );
  return {
    latestVersion: optionalVersion(tags.latest),
    bootstrapVersion: optionalVersion(tags.bootstrap),
    targetIntegrity,
  };
}

function verifyRegistryMetadata(
  packageName: string,
  targetVersion: string,
  qualifiedIntegrity: string,
): void {
  const spec = `${packageName}@${targetVersion}`;
  const version = npmView<string>([spec, "version"]);
  if (version !== targetVersion) throw new Error("published package version drifted");
  const bin = asRecord(npmView<unknown>([spec, "bin"]));
  if (bin.sessions !== EXPECTED_BIN) throw new Error("published sessions executable drifted");
  const engines = asRecord(npmView<unknown>([spec, "engines"]));
  if (engines.node !== EXPECTED_ENGINE) throw new Error("published Node engine drifted");
  const repository = asRecord(npmView<unknown>([spec, "repository"]));
  if (repository.url !== EXPECTED_REPOSITORY) throw new Error("published repository drifted");
  const integrity = npmView<string>([spec, "dist.integrity"]);
  if (integrity !== qualifiedIntegrity) throw new Error("published integrity drifted");
  const attestations = asRecord(npmView<unknown>([spec, "dist.attestations"]));
  const provenance = asRecord(attestations.provenance);
  if (
    typeof attestations.url !== "string" ||
    provenance.predicateType !== "https://slsa.dev/provenance/v1"
  ) {
    throw new Error("published provenance metadata is missing");
  }
}

function optionalVersion(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("registry dist-tag is not a string");
  assertVersion(value, "registry dist-tag");
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function npmView<T>(args: readonly string[], allowMissing = false): T | null {
  const result = spawnSync("npm", ["view", ...args, "--json"], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    if (allowMissing && /\bE404\b/.test(result.stderr)) return null;
    throw new Error(`npm view failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  const trimmed = result.stdout.trim();
  if (trimmed.length === 0) return null;
  return JSON.parse(trimmed) as T;
}

function readRootVersion(file: string): string {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const root = asRecord(parsed);
  const value = file.endsWith("package.json") ? root.version : root["."];
  if (typeof value !== "string") throw new Error(`${path.basename(file)} has no root version`);
  return value;
}

function readParentManifestVersion(cwd: string, beforeSha: string): string | null {
  if (!/^[0-9a-f]{40}$/.test(beforeSha) || /^0+$/.test(beforeSha)) return null;
  const result = spawnSync("git", ["show", `${beforeSha}:.release-please-manifest.json`], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    if (/does not exist|exists on disk, but not in/.test(result.stderr)) return null;
    throw new Error(`cannot read parent release manifest: ${result.stderr.trim()}`);
  }
  const parsed = JSON.parse(result.stdout) as unknown;
  const value = asRecord(parsed)["."];
  if (typeof value !== "string") throw new Error("parent release manifest has no root version");
  return value;
}

function resolveCommit(cwd: string, revision: string, label: string): string {
  const result = spawnSync("git", ["rev-parse", `${revision}^{commit}`], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const commit = result.stdout.trim();
  if (result.status !== 0 || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`${label} does not resolve to a commit`);
  }
  return commit;
}

function assertExactCheckout(cwd: string, headSha: string): void {
  if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error("release SHA must be a full commit SHA");
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 || result.stdout.trim() !== headSha) {
    throw new Error("release workflow checkout does not match the triggering SHA");
  }
}

function writeOutputs(values: Readonly<Record<string, string | boolean>>): void {
  const output = process.env.GITHUB_OUTPUT;
  if (output === undefined) throw new Error("GITHUB_OUTPUT is required");
  for (const [key, value] of Object.entries(values)) {
    appendFileSync(output, `${key}=${String(value)}\n`, "utf8");
  }
}

function valueAfter(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value.length === 0) throw new Error(`${flag} is required`);
  return value;
}

function runRoute(args: readonly string[]): void {
  const cwd = valueAfter(args, "--cwd");
  const eventName = valueAfter(args, "--event");
  if (eventName !== "push" && eventName !== "workflow_dispatch") {
    throw new Error("--event must be push or workflow_dispatch");
  }
  const headSha = valueAfter(args, "--head-sha");
  assertExactCheckout(cwd, headSha);
  const retryReleaseRequested = valueAfter(args, "--retry-release") === "true";
  const currentManifestVersion = readRootVersion(path.join(cwd, ".release-please-manifest.json"));
  const releaseSha = retryReleaseRequested
    ? resolveCommit(cwd, `v${currentManifestVersion}`, "supported release tag")
    : headSha;
  const previousManifestVersion = retryReleaseRequested
    ? readParentManifestVersion(cwd, resolveCommit(cwd, `${releaseSha}^1`, "release parent"))
    : eventName === "push"
      ? readParentManifestVersion(cwd, valueAfter(args, "--before-sha"))
      : null;
  const route = classifyReleaseRoute({
    eventName,
    ref: valueAfter(args, "--ref"),
    bootstrapRequested: valueAfter(args, "--bootstrap") === "true",
    retryReleaseRequested,
    previousManifestVersion,
    currentManifestVersion,
    packageVersion: readRootVersion(path.join(cwd, "package.json")),
    changelog: readFileSync(path.join(cwd, "CHANGELOG.md"), "utf8"),
  });
  writeOutputs({
    qualify: route.qualify,
    release_target: route.releaseTarget,
    mode: route.mode,
    version: route.version,
    parent_version: route.parentVersion,
    reason: route.reason,
    release_sha: releaseSha,
  });
}

interface ArtifactReport {
  readonly schemaVersion?: unknown;
  readonly mode?: unknown;
  readonly version?: unknown;
  readonly tagName?: unknown;
  readonly filename?: unknown;
  readonly tarballPath?: unknown;
  readonly sha256?: unknown;
}

export interface ArtifactWorkflowOutput {
  readonly version: string;
  readonly tagName: string;
  readonly filename: string;
  readonly sha256: string;
}

export function validateArtifactReport(report: ArtifactReport): ArtifactWorkflowOutput {
  const validTag =
    (report.mode === "bootstrap" && report.tagName === null) ||
    (report.mode === "supported" && typeof report.tagName === "string");
  if (
    report.schemaVersion !== 1 ||
    (report.mode !== "bootstrap" && report.mode !== "supported") ||
    !validTag ||
    typeof report.version !== "string" ||
    typeof report.filename !== "string" ||
    !/^[A-Za-z0-9._-]+\.tgz$/.test(report.filename) ||
    typeof report.tarballPath !== "string" ||
    typeof report.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(report.sha256)
  ) {
    throw new Error("package artifact report is invalid");
  }
  assertVersion(report.version, "artifact version");
  const tagName = typeof report.tagName === "string" ? report.tagName : "";
  if (report.mode === "bootstrap" && report.version !== BOOTSTRAP_VERSION) {
    throw new Error("bootstrap artifact version drifted");
  }
  if (report.mode === "supported" && tagName !== `v${report.version}`) {
    throw new Error("artifact tag name drifted");
  }
  if (path.basename(report.tarballPath) !== report.filename) {
    throw new Error("artifact filename and path disagree");
  }
  return {
    version: report.version,
    tagName,
    filename: report.filename,
    sha256: report.sha256,
  };
}

function runArtifactOutput(args: readonly string[]): void {
  const report = JSON.parse(readFileSync(valueAfter(args, "--file"), "utf8")) as ArtifactReport;
  const output = validateArtifactReport(report);
  writeOutputs({
    version: output.version,
    tag_name: output.tagName,
    filename: output.filename,
    sha256: output.sha256,
  });
}

function runPrepublish(args: readonly string[]): void {
  const packageName = valueAfter(args, "--package");
  if (packageName !== EXPECTED_PACKAGE) throw new Error("unexpected release package");
  const targetVersion = valueAfter(args, "--target");
  const parentVersion = valueAfter(args, "--parent");
  const tarball = valueAfter(args, "--tarball");
  const bytes = readFileSync(tarball);
  assertArtifactSha256(bytes, valueAfter(args, "--sha256"));
  const qualifiedIntegrity = computeArtifactIntegrity(bytes);
  const decision = decideReleaseOrder({
    parentVersion,
    targetVersion,
    qualifiedIntegrity,
    ...readRegistryState(packageName, targetVersion),
  });
  writeOutputs({
    action: decision.action,
    integrity: qualifiedIntegrity,
    latest_version: decision.action === "stale-verify" ? decision.latestVersion : targetVersion,
  });
}

function runVerifyRegistry(args: readonly string[]): void {
  const packageName = valueAfter(args, "--package");
  if (packageName !== EXPECTED_PACKAGE) throw new Error("unexpected release package");
  const targetVersion = valueAfter(args, "--target");
  const parentVersion = valueAfter(args, "--parent");
  const bytes = readFileSync(valueAfter(args, "--tarball"));
  assertArtifactSha256(bytes, valueAfter(args, "--sha256"));
  const qualifiedIntegrity = computeArtifactIntegrity(bytes);
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const state = readRegistryState(packageName, targetVersion);
    if (state.targetIntegrity !== null && state.targetIntegrity !== qualifiedIntegrity) {
      decideReleaseOrder({
        parentVersion,
        targetVersion,
        qualifiedIntegrity,
        ...state,
      });
    }
    try {
      const decision = decideReleaseOrder({
        parentVersion,
        targetVersion,
        qualifiedIntegrity,
        ...state,
      });
      if (decision.action === "publish") throw new Error("target version was not published");
      verifyRegistryMetadata(packageName, targetVersion, qualifiedIntegrity);
      return;
    } catch (error) {
      if (attempt === 6) throw error;
      waitForRegistry(5_000);
    }
  }
}

function assertArtifactSha256(bytes: Uint8Array, expected: string): void {
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error("expected artifact SHA-256 is invalid");
  if (computeArtifactSha256(bytes) !== expected) {
    throw new Error("downloaded artifact SHA-256 does not match qualification");
  }
}

function waitForRegistry(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "route") runRoute(args);
  else if (command === "assert-checkout") {
    assertExactCheckout(valueAfter(args, "--cwd"), valueAfter(args, "--head-sha"));
  } else if (command === "artifact-output") runArtifactOutput(args);
  else if (command === "prepublish") runPrepublish(args);
  else if (command === "verify-registry") runVerifyRegistry(args);
  else {
    throw new Error(
      "expected route, assert-checkout, artifact-output, prepublish, or verify-registry",
    );
  }
}
