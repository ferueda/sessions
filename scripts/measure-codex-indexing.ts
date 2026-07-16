import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  captureCodexEnvironment,
  resolveCodexPaths,
  type ResolvedCodexPaths,
} from "../src/adapters/codex/paths.ts";
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

const ACKNOWLEDGEMENT = "--allow-provider-read";
const COHORT_SESSIONS = 120;
const FILE_BUFFER_BYTES = 128 * 1024;
const TEMPORARY_PREFIX = "sessions-codex-indexing-";
const PRIVATE_RESIDUE_WARNING =
  "sessions: Codex indexing measurement failed. An uncatchable process or machine failure can leave private temporary residue.\n";

type MeasurementFailureCode = "acknowledgement-required" | "unsupported-platform";

class MeasurementFailure extends Error {
  readonly code: MeasurementFailureCode;

  constructor(code: MeasurementFailureCode) {
    super("Codex indexing measurement was refused");
    this.name = "MeasurementFailure";
    this.code = code;
  }
}

interface OwnedTemporaryRoot {
  readonly path: string;
  readonly dev?: bigint;
  readonly ino?: bigint;
}

interface ProviderSnapshot {
  readonly digest: string;
  readonly fileCount: number;
  readonly bytes: number;
}

interface ProviderSnapshotEntry {
  readonly key: string;
  readonly kind: "directory" | "file" | "missing";
  readonly dev?: string;
  readonly ino?: string;
  readonly mode?: string;
  readonly size?: string;
  readonly mtimeNs?: string;
  readonly ctimeNs?: string;
  readonly birthtimeNs?: string;
  readonly contentDigest?: string;
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
  const temporary = await createOwnedTemporaryRoot();
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

  // Path resolution reads only Codex configuration; the snapshot below is
  // limited to provider state and rollouts and never walks the Codex home.
  const codexPaths = await resolveCodexPaths(environment);
  const providerBefore = await snapshotCodexProvider(codexPaths);
  const lifecycle = createSqliteIndexLifecycle({ platform });
  const clock = Object.freeze({ now: () => new Date() });

  const seedSource = limitDiscovery(await createCodexSource(environment));
  const seed = await runIndex({
    paths: indexPaths,
    sources: [seedSource],
    lifecycle,
    clock,
  });

  const timings = createIndexTimingCollector();
  const stable = await timeIndexOperation(timings.recorder, "total", async () => {
    const selected = await timeIndexOperation(timings.recorder, "sourceResolution", () =>
      createCodexSource(environment),
    );
    return runIndex({
      paths: indexPaths,
      sources: [limitDiscovery(selected)],
      lifecycle,
      clock,
      timing: timings.recorder,
    });
  });
  const providerAfter = await snapshotCodexProvider(codexPaths);
  const providerSnapshotEqual = sameProviderSnapshot(providerBefore, providerAfter);
  requireCondition(providerSnapshotEqual);

  requireCompleteReport(seed, {
    discovered: COHORT_SESSIONS,
    unchanged: 0,
    updated: COHORT_SESSIONS,
    failed: 0,
    missing: 0,
    stale: 0,
  });
  requireCompleteReport(stable, {
    discovered: COHORT_SESSIONS,
    unchanged: COHORT_SESSIONS,
    updated: 0,
    failed: 0,
    missing: 0,
    stale: 0,
  });
  const health = await lifecycle.inspectHealth(indexPaths);
  requireCondition(health.ok && health.writerLease === "free");

  const timingSnapshot = timings.snapshot();
  requireCondition(timingSnapshot.phases.changedReadAndNormalize.calls === 0);
  return Object.freeze({
    cohortSessions: COHORT_SESSIONS,
    sourceFiles: providerBefore.fileCount,
    sourceBytes: providerBefore.bytes,
    providerSnapshotEqual,
    seedComplete: true,
    seedCounts: seed.counts,
    stableComplete: true,
    stableCounts: stable.counts,
    libraryHealthy: true,
    timings: timingSnapshot.phases,
  });
}

function limitDiscovery(selected: SelectedSessionSource): SelectedSessionSource {
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
      yield* completeGeneration.slice(0, COHORT_SESSIONS);
    },
    read: (candidate: DiscoveredSession) => selected.adapter.read(candidate),
  });
  return Object.freeze({ instance: selected.instance, adapter });
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

async function snapshotCodexProvider(paths: ResolvedCodexPaths): Promise<ProviderSnapshot> {
  const entries: ProviderSnapshotEntry[] = [];
  await snapshotRequiredFile(paths.stateDatabase, "state/database", entries);
  await snapshotOptionalFile(`${paths.stateDatabase}-wal`, "state/database-wal", entries);
  await snapshotOptionalTree(paths.sessionsRoot, "rollouts/sessions", entries);
  await snapshotOptionalTree(paths.archivedSessionsRoot, "rollouts/archived", entries);
  entries.sort((left, right) => compareBinaryStrings(left.key, right.key));

  let fileCount = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (entry.kind !== "file") continue;
    fileCount = addSafeInteger(fileCount, 1);
    bytes = addSafeInteger(bytes, parseSafeBytes(entry.size));
  }
  return Object.freeze({
    digest: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    fileCount,
    bytes,
  });
}

async function snapshotRequiredFile(
  file: string,
  key: string,
  entries: ProviderSnapshotEntry[],
): Promise<void> {
  const stats = await lstat(file, { bigint: true });
  requireCondition(stats.isFile());
  entries.push(await snapshotRegularFile(file, key, stats));
}

async function snapshotOptionalFile(
  file: string,
  key: string,
  entries: ProviderSnapshotEntry[],
): Promise<void> {
  let stats: BigIntStats;
  try {
    stats = await lstat(file, { bigint: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
    entries.push({ key, kind: "missing" });
    return;
  }
  requireCondition(stats.isFile());
  entries.push(await snapshotRegularFile(file, key, stats));
}

async function snapshotOptionalTree(
  root: string,
  key: string,
  entries: ProviderSnapshotEntry[],
): Promise<void> {
  let stats: BigIntStats;
  try {
    stats = await lstat(root, { bigint: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
    entries.push({ key, kind: "missing" });
    return;
  }
  requireCondition(stats.isDirectory());
  await snapshotTree(root, key, stats, entries);
}

async function snapshotTree(
  directory: string,
  key: string,
  initialStats: BigIntStats,
  entries: ProviderSnapshotEntry[],
): Promise<void> {
  requireCondition(initialStats.isDirectory());
  entries.push({ key, kind: "directory", ...snapshotMetadata(initialStats) });

  const children = (await readdir(directory)).sort(compareBinaryStrings);
  requireCondition(sameSnapshotStat(initialStats, await lstat(directory, { bigint: true })));
  for (const child of children) {
    const childPath = path.join(directory, child);
    const childKey = `${key}/${child}`;
    const stats = await lstat(childPath, { bigint: true });
    if (stats.isDirectory()) {
      await snapshotTree(childPath, childKey, stats, entries);
    } else {
      // Symlinks and special files are deliberately rejected rather than followed.
      requireCondition(stats.isFile());
      entries.push(await snapshotRegularFile(childPath, childKey, stats));
    }
  }
  requireCondition(sameSnapshotStat(initialStats, await lstat(directory, { bigint: true })));
}

async function snapshotRegularFile(
  file: string,
  key: string,
  pathStats: BigIntStats,
): Promise<ProviderSnapshotEntry> {
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
    key,
    kind: "file",
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

function sameProviderSnapshot(left: ProviderSnapshot, right: ProviderSnapshot): boolean {
  return (
    left.digest === right.digest && left.fileCount === right.fileCount && left.bytes === right.bytes
  );
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
  if (args.length !== 1 || args[0] !== ACKNOWLEDGEMENT) {
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
  return PRIVATE_RESIDUE_WARNING;
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
