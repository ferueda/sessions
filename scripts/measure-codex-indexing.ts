import { createHash } from "node:crypto";
import { constants, type BigIntStats, type Dirent } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import {
  captureCodexEnvironment,
  describeRollout,
  resolveCodexPaths,
  rolloutDescriptorTuple,
  type ResolvedCodexPaths,
} from "../src/adapters/codex/paths.ts";
import { fingerprintCodexTuple } from "../src/adapters/codex/fingerprint.ts";
import { createCodexSource } from "../src/adapters/codex/source.ts";
import { compareBinaryStrings } from "../src/application/discover-sessions.ts";
import { timeIndexOperation } from "../src/application/index-timing.ts";
import type { IndexReport } from "../src/application/index-report.ts";
import type {
  DiscoveredSession,
  SelectedSessionSource,
  SessionSource,
  SourceDiscoveryWorkspace,
} from "../src/application/ports/session-source.ts";
import { runIndex } from "../src/application/run-index.ts";
import { createIndexTimingCollector } from "../src/infrastructure/runtime/index-timings.ts";
import { resolveIndexPaths } from "../src/infrastructure/state/paths.ts";
import { createSqliteIndexLifecycle } from "../src/infrastructure/sqlite/database.ts";
import { CURRENT_INDEX_SCHEMA_VERSION } from "../src/infrastructure/sqlite/migrations.ts";
import { readWriterCleanProof } from "../src/infrastructure/sqlite/writer-clean-proof.ts";

const ACKNOWLEDGEMENT = "--allow-provider-read";
const COHORT_SESSIONS = 120;
const CLEAN_WRITER_OPEN_BUDGET_MS = 800;
const STABLE_TOTAL_BUDGET_MS = 1_250;
const FILE_BUFFER_BYTES = 128 * 1024;
const TEMPORARY_PREFIX = "sessions-codex-indexing-";
const PRIVATE_RESIDUE_WARNING =
  "sessions: Codex indexing measurement failed. An uncatchable process or machine failure can leave private temporary residue.\n";

type MeasurementFailureCode = "acknowledgement-required" | "unsupported-platform";
type MeasurementStage =
  | "temporary-state"
  | "seed-index"
  | "stable-index"
  | "selected-provider-after"
  | "provider-stability"
  | "seed-admission"
  | "stable-admission"
  | "timing-admission"
  | "library-health";

class MeasurementFailure extends Error {
  readonly code: MeasurementFailureCode;

  constructor(code: MeasurementFailureCode) {
    super("Codex indexing measurement was refused");
    this.name = "MeasurementFailure";
    this.code = code;
  }
}

class MeasurementStageFailure extends Error {
  readonly stage: MeasurementStage;

  constructor(stage: MeasurementStage, cause: unknown) {
    super("Codex indexing measurement stage failed", { cause });
    this.name = "MeasurementStageFailure";
    this.stage = stage;
  }
}

interface OwnedTemporaryRoot {
  readonly path: string;
  readonly dev?: bigint;
  readonly ino?: bigint;
}

interface SelectedRolloutSnapshot {
  readonly candidateSignature: string;
  readonly descriptorFingerprint: string;
  readonly dev?: string;
  readonly ino?: string;
  readonly mode?: string;
  readonly size?: string;
  readonly mtimeNs?: string;
  readonly ctimeNs?: string;
  readonly birthtimeNs?: string;
  readonly contentDigest?: string;
}

interface SelectedCohort {
  readonly candidates: readonly DiscoveredSession[];
  readonly candidateSignatures: readonly string[];
  readonly rolloutSnapshots: readonly SelectedRolloutSnapshot[];
}

let ownedTemporaryRoot: OwnedTemporaryRoot | undefined;
let cleanupOperation: Promise<void> | undefined;
let signalExitStarted = false;

let removeSignalHandlers: () => void = () => undefined;
let output: Awaited<ReturnType<typeof measureCodexIndexing>> | undefined;
let failure: unknown;

try {
  const platform = admitInvocation(process.argv.slice(2), process.platform);
  removeSignalHandlers = installSignalHandlers();
  output = await measureCodexIndexing(platform);
} catch (error) {
  failure = error;
}

try {
  await cleanupOwnedTemporaryRoot();
} catch (error) {
  failure ??= error;
}
removeSignalHandlers();

if (failure !== undefined) {
  process.stderr.write(failureMessage(failure));
  process.exitCode = 1;
} else if (output !== undefined) {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

async function measureCodexIndexing(platform: "darwin" | "linux") {
  const temporary = await runStage("temporary-state", createOwnedTemporaryRoot);
  const dataDirectory = path.join(temporary.path, "sessions-data");
  await createPrivateDirectory(dataDirectory);
  const environment = captureCodexEnvironment();
  const indexPaths = resolveIndexPaths({
    platform,
    env: { ...process.env, SESSIONS_DATA_DIR: dataDirectory },
    homeDirectory: environment.home,
  });
  requireCondition(indexPaths.directory === dataDirectory);
  await requireFreshDataDirectory(
    dataDirectory,
    indexPaths.database,
    indexPaths.wal,
    indexPaths.shm,
  );

  // Path resolution reads only Codex configuration. Cohort capture below uses
  // the production adapter observations and hashes only selected rollouts.
  const codexPaths = await resolveCodexPaths(environment);
  const lifecycle = createSqliteIndexLifecycle({ platform });
  const clock = Object.freeze({ now: () => new Date() });

  const seedTimings = createIndexTimingCollector();
  let seedCohort: SelectedCohort | undefined;
  const seed = await runStage("seed-index", () =>
    timeIndexOperation(seedTimings.recorder, "total", async () => {
      const selected = await timeIndexOperation(seedTimings.recorder, "sourceResolution", () =>
        createCodexSource(environment),
      );
      return runIndex({
        paths: indexPaths,
        sources: [
          limitDiscovery(selected, codexPaths, (cohort) => {
            seedCohort = cohort;
          }),
        ],
        lifecycle,
        clock,
        timing: seedTimings.recorder,
      });
    }),
  );
  const seedClean = await writerCleanStateIsValid(indexPaths.database, platform);

  const timings = createIndexTimingCollector();
  let stableCohort: SelectedCohort | undefined;
  const stable = await runStage("stable-index", () =>
    timeIndexOperation(timings.recorder, "total", async () => {
      const selected = await timeIndexOperation(timings.recorder, "sourceResolution", () =>
        createCodexSource(environment),
      );
      return runIndex({
        paths: indexPaths,
        sources: [
          limitDiscovery(selected, codexPaths, (cohort) => {
            stableCohort = cohort;
          }),
        ],
        lifecycle,
        clock,
        timing: timings.recorder,
      });
    }),
  );
  const stableClean = await writerCleanStateIsValid(indexPaths.database, platform);
  const admittedSeedCohort = requireCapturedCohort(seedCohort);
  const admittedStableCohort = requireCapturedCohort(stableCohort);
  const cohortEqual = sameSelectedCohort(admittedSeedCohort, admittedStableCohort);
  const providerAfter = await runStage("selected-provider-after", () =>
    captureSelectedCohort(admittedStableCohort.candidates, codexPaths),
  );
  const selectedRolloutBytesEqual = sameSelectedRolloutSnapshots(
    admittedSeedCohort.rolloutSnapshots,
    admittedStableCohort.rolloutSnapshots,
    providerAfter.rolloutSnapshots,
  );
  await runStage("provider-stability", async () => {
    requireCondition(cohortEqual && selectedRolloutBytesEqual);
  });
  await runStage("seed-admission", async () => {
    requireCondition(seedClean);
    requireCompleteReport(seed, {
      discovered: COHORT_SESSIONS,
      unchanged: 0,
      updated: COHORT_SESSIONS,
      failed: 0,
      missing: 0,
      stale: 0,
    });
  });
  await runStage("stable-admission", async () => {
    requireCondition(stableClean);
    requireCompleteReport(stable, {
      discovered: COHORT_SESSIONS,
      unchanged: COHORT_SESSIONS,
      updated: 0,
      failed: 0,
      missing: 0,
      stale: 0,
    });
  });
  await runStage("library-health", async () => {
    const health = await lifecycle.inspectHealth(indexPaths);
    requireCondition(health.ok && health.writerLease === "free");
  });

  const seedTimingSnapshot = seedTimings.snapshot();
  const timingSnapshot = timings.snapshot();
  await runStage("timing-admission", async () =>
    requireCondition(
      timingSnapshot.phases.changedReadAndNormalize.calls === 0 &&
        timingSnapshot.phases.writerOpen.calls === 1 &&
        timingSnapshot.phases.writerOpen.elapsedMs <= CLEAN_WRITER_OPEN_BUDGET_MS &&
        timingSnapshot.phases.total.calls === 1 &&
        timingSnapshot.phases.total.elapsedMs <= STABLE_TOTAL_BUDGET_MS,
    ),
  );
  const selectedRolloutBytes = admittedSeedCohort.rolloutSnapshots.reduce(
    (sum, snapshot) => addSafeInteger(sum, parseSafeBytes(snapshot.size)),
    0,
  );
  return Object.freeze({
    cohortSessions: COHORT_SESSIONS,
    selectedRolloutFiles: admittedSeedCohort.rolloutSnapshots.length,
    selectedRolloutBytes,
    cohortEqual,
    selectedRolloutBytesEqual,
    seedComplete: true,
    seedCounts: seed.counts,
    stableComplete: true,
    stableCounts: stable.counts,
    libraryHealthy: true,
    writerIntegrityState: true,
    seedTimings: seedTimingSnapshot.phases,
    timings: timingSnapshot.phases,
  });
}

async function writerCleanStateIsValid(
  databasePath: string,
  platform: "darwin" | "linux",
): Promise<boolean> {
  const proof = await readWriterCleanProof(databasePath, { platform });
  if (proof === undefined) return false;
  const database = new DatabaseSync(pathToImmutableDatabase(databasePath), {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    readOnly: true,
  });
  try {
    const row = database
      .prepare(
        `SELECT library.instance_id,
                lease.generation,
                lease.clean_generation,
                lease.clean_schema_cookie,
                lease.purpose,
                lease.owner_token
         FROM sessions_library AS library
         CROSS JOIN sessions_writer_lease AS lease
         WHERE library.singleton = 1 AND lease.singleton = 1`,
      )
      .get() as Record<string, unknown> | undefined;
    const schemaCookie = Object.values(database.prepare("PRAGMA schema_version").get() ?? {})[0];
    return (
      row?.instance_id === proof.libraryInstanceId &&
      row.generation === proof.writerGeneration &&
      row.clean_generation === proof.writerGeneration &&
      row.clean_schema_cookie === proof.schemaCookie &&
      row.purpose === null &&
      row.owner_token === null &&
      proof.schemaVersion === CURRENT_INDEX_SCHEMA_VERSION &&
      schemaCookie === proof.schemaCookie
    );
  } finally {
    database.close();
  }
}

function pathToImmutableDatabase(databasePath: string): string {
  const url = pathToFileURL(databasePath);
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");
  return url.href;
}

function limitDiscovery(
  selected: SelectedSessionSource,
  paths: ResolvedCodexPaths,
  capture: (cohort: SelectedCohort) => void,
): SelectedSessionSource {
  const adapter: SessionSource = Object.freeze({
    kind: selected.adapter.kind,
    probe: () => selected.adapter.probe(),
    async *discover(workspace: SourceDiscoveryWorkspace): AsyncIterable<DiscoveredSession> {
      const completeGeneration: DiscoveredSession[] = [];
      for await (const candidate of selected.adapter.discover(workspace)) {
        completeGeneration.push(candidate);
      }
      completeGeneration.sort((left, right) =>
        compareBinaryStrings(left.identity.nativeId, right.identity.nativeId),
      );
      const cohort = completeGeneration.slice(0, COHORT_SESSIONS);
      capture(await captureSelectedCohort(cohort, paths));
      yield* cohort;
    },
    read: (candidate: DiscoveredSession) => selected.adapter.read(candidate),
  });
  return Object.freeze({ instance: selected.instance, adapter });
}

async function captureSelectedCohort(
  candidates: readonly DiscoveredSession[],
  paths: ResolvedCodexPaths,
): Promise<SelectedCohort> {
  const logicalNames = candidates.map(rolloutLogicalName);
  const filesByLogicalName = await findSelectedRolloutFiles(paths, logicalNames);
  const rolloutSnapshots: SelectedRolloutSnapshot[] = [];
  for (const candidate of candidates) {
    rolloutSnapshots.push(await snapshotCandidateRollout(candidate, paths, filesByLogicalName));
  }
  return Object.freeze({
    candidates: Object.freeze([...candidates]),
    candidateSignatures: Object.freeze(candidates.map(candidateSignature)),
    rolloutSnapshots: Object.freeze(rolloutSnapshots),
  });
}

function candidateSignature(candidate: DiscoveredSession): string {
  return JSON.stringify([
    candidate.identity.source.kind,
    candidate.identity.source.instanceId,
    candidate.identity.nativeId,
    candidate.adapterVersion,
    candidate.aggregateFingerprint.scheme,
    candidate.aggregateFingerprint.digest,
    candidate.inputs.map((input) => [
      input.role,
      input.locator.uri,
      input.locator.recordId ?? null,
      input.fingerprint,
    ]),
  ]);
}

function rolloutLogicalName(candidate: DiscoveredSession): string {
  const uri = rolloutInput(candidate).locator.uri;
  const prefix = "codex://rollout/";
  requireCondition(uri !== undefined && uri.startsWith(prefix));
  const logicalName = decodeURIComponent(uri.slice(prefix.length));
  requireCondition(
    logicalName.length > 0 &&
      logicalName.isWellFormed() &&
      !logicalName.includes("/") &&
      !logicalName.includes("\\"),
  );
  return logicalName;
}

function rolloutInput(candidate: DiscoveredSession) {
  const rolloutInputs = candidate.inputs.filter((input) => input.role === "rollout");
  requireCondition(rolloutInputs.length === 1 && rolloutInputs[0] !== undefined);
  return rolloutInputs[0];
}

async function findSelectedRolloutFiles(
  paths: ResolvedCodexPaths,
  logicalNames: readonly string[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  const uniqueNames = new Set(logicalNames);
  requireCondition(uniqueNames.size === logicalNames.length);
  const matches = new Map<string, string[]>([...uniqueNames].map((name) => [name, []]));
  await collectSelectedRolloutFiles(paths.sessionsRoot, uniqueNames, matches);
  await collectSelectedRolloutFiles(paths.archivedSessionsRoot, uniqueNames, matches);
  return matches;
}

async function collectSelectedRolloutFiles(
  directory: string,
  logicalNames: ReadonlySet<string>,
  matches: Map<string, string[]>,
): Promise<void> {
  const children = await readDirectoryEntries(directory);
  children.sort((left, right) => compareBinaryStrings(left.name, right.name));
  for (const child of children) {
    const childPath = path.join(directory, child.name);
    if (child.isDirectory()) {
      const stats = await lstat(childPath, { bigint: true });
      requireCondition(stats.isDirectory());
      await collectSelectedRolloutFiles(childPath, logicalNames, matches);
      continue;
    }
    const logicalName = child.name.endsWith(".zst") ? child.name.slice(0, -4) : child.name;
    if (!logicalNames.has(logicalName)) continue;
    const stats = await lstat(childPath, { bigint: true });
    requireCondition(stats.isFile());
    matches.get(logicalName)?.push(childPath);
  }
}

async function readDirectoryEntries(directory: string): Promise<Dirent<string>[]> {
  try {
    return await readdir(directory, { encoding: "utf8", withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function snapshotCandidateRollout(
  candidate: DiscoveredSession,
  paths: ResolvedCodexPaths,
  filesByLogicalName: ReadonlyMap<string, readonly string[]>,
): Promise<SelectedRolloutSnapshot> {
  const input = rolloutInput(candidate);
  const logicalName = rolloutLogicalName(candidate);
  const matchingDescriptors = new Map<string, Awaited<ReturnType<typeof describeRollout>>>();
  for (const file of filesByLogicalName.get(logicalName) ?? []) {
    const descriptor = await describeRollout(paths, file, candidate.identity.nativeId);
    if (
      descriptor.status === "ready" &&
      descriptor.file !== undefined &&
      fingerprintCodexTuple(rolloutDescriptorTuple(descriptor)) === input.fingerprint
    ) {
      matchingDescriptors.set(descriptor.file, descriptor);
    }
  }
  requireCondition(matchingDescriptors.size === 1);
  const descriptor = matchingDescriptors.values().next().value;
  requireCondition(descriptor?.file !== undefined);
  const descriptorFingerprint = fingerprintCodexTuple(rolloutDescriptorTuple(descriptor));
  const pathStats = await lstat(descriptor.file, { bigint: true });
  return snapshotRegularFile(
    descriptor.file,
    candidateSignature(candidate),
    descriptorFingerprint,
    pathStats,
  );
}

function requireCompleteReport(report: IndexReport, counts: IndexReport["counts"]): void {
  requireCondition(report.incompleteSources === 0);
  requireCondition(report.omittedItemCount === 0);
  requireCondition(report.sources.length === 1);
  const source = report.sources[0];
  requireCondition(source?.status === "completed");
  requireCondition(source.coverage.status === "complete");
  requireCondition(source.omittedItemCount === 0);
  requireCondition(source.items.length === 0);
  requireCondition(sameCounts(report.counts, counts));
  requireCondition(sameCounts(source.counts, counts));
}

function sameCounts(left: IndexReport["counts"], right: IndexReport["counts"]): boolean {
  return (
    left.discovered === right.discovered &&
    left.unchanged === right.unchanged &&
    left.updated === right.updated &&
    left.failed === right.failed &&
    left.missing === right.missing &&
    left.stale === right.stale
  );
}

async function snapshotRegularFile(
  file: string,
  candidateSignature: string,
  descriptorFingerprint: string,
  pathStats: BigIntStats,
): Promise<SelectedRolloutSnapshot> {
  requireCondition(pathStats.isFile());
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let operationError: unknown;
  let contentDigest: string | undefined;
  try {
    const openedStats = await handle.stat({ bigint: true });
    requireCondition(openedStats.isFile() && sameSnapshotStat(pathStats, openedStats));
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(FILE_BUFFER_BYTES);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      position = addSafeInteger(position, bytesRead);
      hash.update(buffer.subarray(0, bytesRead));
    }
    requireCondition(position === parseSafeBytes(pathStats.size.toString(10)));
    requireCondition(sameSnapshotStat(pathStats, await handle.stat({ bigint: true })));
    requireCondition(sameSnapshotStat(pathStats, await lstat(file, { bigint: true })));
    contentDigest = hash.digest("hex");
  } catch (error) {
    operationError = error;
  }

  let closeError: unknown;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  if (operationError !== undefined || closeError !== undefined || contentDigest === undefined) {
    throw operationError ?? closeError ?? new Error("Provider snapshot failed");
  }
  return {
    candidateSignature,
    descriptorFingerprint,
    ...snapshotMetadata(pathStats),
    contentDigest,
  };
}

function snapshotMetadata(stats: BigIntStats) {
  return {
    dev: stats.dev.toString(10),
    ino: stats.ino.toString(10),
    mode: stats.mode.toString(10),
    size: stats.size.toString(10),
    mtimeNs: stats.mtimeNs.toString(10),
    ctimeNs: stats.ctimeNs.toString(10),
    birthtimeNs: stats.birthtimeNs.toString(10),
  };
}

function sameSnapshotStat(left: BigIntStats, right: BigIntStats): boolean {
  return (
    right.isFile() === left.isFile() &&
    right.isDirectory() === left.isDirectory() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function requireCapturedCohort(cohort: SelectedCohort | undefined): SelectedCohort {
  requireCondition(cohort !== undefined);
  return cohort;
}

function sameSelectedCohort(left: SelectedCohort, right: SelectedCohort): boolean {
  return sameStringArrays(left.candidateSignatures, right.candidateSignatures);
}

function sameSelectedRolloutSnapshots(
  first: readonly SelectedRolloutSnapshot[],
  second: readonly SelectedRolloutSnapshot[],
  third: readonly SelectedRolloutSnapshot[],
): boolean {
  const expected = JSON.stringify(first);
  return expected === JSON.stringify(second) && expected === JSON.stringify(third);
}

function sameStringArrays(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function createOwnedTemporaryRoot(): Promise<OwnedTemporaryRoot> {
  const root = await mkdtemp(path.join(tmpdir(), TEMPORARY_PREFIX));
  ownedTemporaryRoot = { path: root };
  await chmod(root, 0o700);
  const stats = await lstat(root, { bigint: true });
  requirePrivateDirectory(stats);
  const owned = Object.freeze({ path: root, dev: stats.dev, ino: stats.ino });
  ownedTemporaryRoot = owned;
  return owned;
}

async function createPrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);
  requirePrivateDirectory(await lstat(directory, { bigint: true }));
}

function requirePrivateDirectory(stats: BigIntStats): void {
  requireCondition(stats.isDirectory());
  requireCondition((stats.mode & 0o777n) === 0o700n);
}

async function requireFreshDataDirectory(
  directory: string,
  ...ownedFiles: readonly string[]
): Promise<void> {
  requireCondition((await readdir(directory)).length === 0);
  for (const file of ownedFiles) {
    try {
      await lstat(file);
      requireCondition(false);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

function installSignalHandlers(): () => void {
  const onInterrupt = () => {
    void exitAfterSignal("SIGINT");
  };
  const onTerminate = () => {
    void exitAfterSignal("SIGTERM");
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  return () => {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  };
}

async function exitAfterSignal(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  if (signalExitStarted) return;
  signalExitStarted = true;
  try {
    await cleanupOwnedTemporaryRoot();
  } catch {
    process.stderr.write(PRIVATE_RESIDUE_WARNING);
  }
  process.exit(signal === "SIGINT" ? 130 : 143);
}

function cleanupOwnedTemporaryRoot(): Promise<void> {
  cleanupOperation ??= removeOwnedTemporaryRoot();
  return cleanupOperation;
}

async function removeOwnedTemporaryRoot(): Promise<void> {
  const owned = ownedTemporaryRoot;
  ownedTemporaryRoot = undefined;
  if (owned === undefined) return;

  let stats: BigIntStats;
  try {
    stats = await lstat(owned.path, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  requireCondition(stats.isDirectory());
  if (owned.dev !== undefined) requireCondition(stats.dev === owned.dev);
  if (owned.ino !== undefined) requireCondition(stats.ino === owned.ino);
  await rm(owned.path, { recursive: true, force: true });
}

function admitInvocation(args: readonly string[], platform: NodeJS.Platform): "darwin" | "linux" {
  const admittedArgs = args[0] === "--" ? args.slice(1) : args;
  if (admittedArgs.length !== 1 || admittedArgs[0] !== ACKNOWLEDGEMENT) {
    throw new MeasurementFailure("acknowledgement-required");
  }
  if (platform !== "darwin" && platform !== "linux") {
    throw new MeasurementFailure("unsupported-platform");
  }
  return platform;
}

function failureMessage(error: unknown): string {
  if (error instanceof MeasurementFailure) {
    return error.code === "acknowledgement-required"
      ? `sessions: Codex indexing measurement requires exactly ${ACKNOWLEDGEMENT}.\n`
      : "sessions: Codex indexing measurement is supported only on macOS and Linux.\n";
  }
  if (error instanceof MeasurementStageFailure) {
    return `sessions: Codex indexing measurement failed at ${error.stage}. An uncatchable process or machine failure can leave private temporary residue.\n`;
  }
  return PRIVATE_RESIDUE_WARNING;
}

async function runStage<T>(stage: MeasurementStage, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof MeasurementStageFailure) throw error;
    throw new MeasurementStageFailure(stage, error);
  }
}

function parseSafeBytes(value: string | undefined): number {
  requireCondition(value !== undefined && /^(?:0|[1-9][0-9]*)$/u.test(value));
  const parsed = Number(value);
  requireCondition(Number.isSafeInteger(parsed) && parsed >= 0);
  return parsed;
}

function addSafeInteger(left: number, right: number): number {
  const value = left + right;
  requireCondition(Number.isSafeInteger(value) && value >= 0);
  return value;
}

function requireCondition(condition: unknown): asserts condition {
  if (!condition) throw new Error("Codex indexing measurement invariant failed");
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
