import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { cursorAgentStoreDirectory } from "../src/adapters/cursor/discovery.ts";
import {
  compareCursorComponents,
  cursorPath,
  type CursorEntryDescriptor,
} from "../src/adapters/cursor/filesystem.ts";
import {
  inventoryCursorSource,
  type CursorSqliteInventory,
  type CursorStructuralInventory,
} from "../src/adapters/cursor/inventory.ts";
import {
  captureCursorEnvironment,
  resolveCursorPaths,
  type ResolvedCursorPaths,
} from "../src/adapters/cursor/paths.ts";
import { createCursorSource } from "../src/adapters/cursor/source.ts";
import { compareBinaryStrings } from "../src/application/discover-sessions.ts";
import { throwIfIndexInterrupted } from "../src/application/index-interruption.ts";
import { timeIndexOperation } from "../src/application/index-timing.ts";
import type { IndexReport } from "../src/application/index-report.ts";
import type {
  DiscoveredSession,
  SelectedSessionSource,
  SessionSource,
  SourceCaptureWorkspace,
} from "../src/application/ports/session-source.ts";
import { readSessionDocument } from "../src/application/read-session-document.ts";
import { isSourceFailureError, type SourceFailure } from "../src/application/source-failure.ts";
import { runIndex } from "../src/application/run-index.ts";
import { installIndexInterrupt } from "../src/infrastructure/runtime/index-interrupt.ts";
import { createIndexTimingCollector } from "../src/infrastructure/runtime/index-timings.ts";
import { resolveIndexPaths } from "../src/infrastructure/state/paths.ts";
import { createSqliteIndexLifecycle } from "../src/infrastructure/sqlite/database.ts";
import { CURRENT_INDEX_SCHEMA_VERSION } from "../src/infrastructure/sqlite/migrations.ts";
import { readWriterCleanProof } from "../src/infrastructure/sqlite/writer-clean-proof.ts";

const ACKNOWLEDGEMENT = "--allow-provider-read";
const COHORT_SESSIONS = 120;
const FILE_BUFFER_BYTES = 128 * 1024;
const TEMPORARY_PREFIX = "sessions-cursor-indexing-";
const RESIDUE_WARNING =
  "sessions: Cursor indexing measurement failed. An uncatchable process or machine failure can leave private temporary residue.\n";

type SupportedPlatform = "darwin" | "linux";
type MeasurementFailureCode = "acknowledgement-required" | "unsupported-platform";
type MeasurementStage =
  | "temporary-state"
  | "source-resolution"
  | "preflight"
  | "seed-index"
  | "stable-index"
  | "provider-stability"
  | "seed-admission"
  | "stable-admission"
  | "library-health";

class MeasurementFailure extends Error {
  readonly code: MeasurementFailureCode;

  constructor(code: MeasurementFailureCode) {
    super("Cursor indexing measurement was refused");
    this.name = "MeasurementFailure";
    this.code = code;
  }
}

class MeasurementStageFailure extends Error {
  readonly stage: MeasurementStage;

  constructor(stage: MeasurementStage, cause: unknown) {
    super("Cursor indexing measurement stage failed", { cause });
    this.name = "MeasurementStageFailure";
    this.stage = stage;
  }
}

interface WorkspaceDeliverySnapshot {
  readonly discoveryCalls: number;
  readonly readCalls: number;
  readonly exactWorkspaceReference: boolean;
}

interface WorkspaceDeliveryTracker {
  recordDiscovery(workspace: SourceCaptureWorkspace): void;
  recordRead(workspace: SourceCaptureWorkspace): void;
  snapshot(): WorkspaceDeliverySnapshot;
}

interface ProviderFileSnapshot {
  readonly key: string;
  readonly size: number;
  readonly digest: string;
}

interface CohortSnapshot {
  readonly candidates: readonly DiscoveredSession[];
  readonly candidateSignatures: readonly string[];
  readonly files: readonly ProviderFileSnapshot[];
}

interface PreflightResult {
  readonly signatures: readonly string[];
  readonly files: readonly ProviderFileSnapshot[];
  readonly failureTotals: Readonly<Record<PreflightFailureKind, number>>;
}

type PreflightFailureKind = SourceFailure["kind"];

interface OwnedTemporaryRoot {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

let temporaryRoot: OwnedTemporaryRoot | undefined;
const interrupt = installIndexInterrupt();
let output: Awaited<ReturnType<typeof measureCursorIndexing>> | undefined;
let failure: unknown;

try {
  const platform = admitInvocation(process.argv.slice(2), process.platform);
  output = await measureCursorIndexing(platform, interrupt.signal);
} catch (error) {
  failure = error;
}

try {
  await cleanupTemporaryRoot();
} catch (error) {
  failure ??= error;
}
interrupt.dispose();

if (failure !== undefined) {
  process.stderr.write(failureMessage(failure));
  process.exitCode = interrupt.interruption?.exitCode ?? 1;
} else if (output !== undefined) {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

async function measureCursorIndexing(platform: SupportedPlatform, signal: AbortSignal) {
  const root = await runStage("temporary-state", async () => {
    const value = await mkdtemp(path.join(tmpdir(), TEMPORARY_PREFIX));
    await chmod(value, 0o700);
    const stats = await lstat(value, { bigint: true });
    requireCondition(stats.isDirectory() && (stats.mode & 0o777n) === 0o700n);
    temporaryRoot = { path: value, dev: stats.dev, ino: stats.ino };
    await mkdir(path.join(value, "private"), { mode: 0o700 });
    return value;
  });
  const environment = captureCursorEnvironment();
  const cursorPaths = await runStage("source-resolution", () => resolveCursorPaths(environment));
  const selected = await runStage("source-resolution", () => createCursorSource(environment));
  const captureWorkspace = createCaptureWorkspace(path.join(root, "private"));
  const preflight = await runStage("preflight", () =>
    preflightCohort(selected, cursorPaths, captureWorkspace, signal),
  );

  const dataDirectory = path.join(root, "sessions-data");
  await mkdir(dataDirectory, { mode: 0o700 });
  const indexPaths = resolveIndexPaths({
    platform,
    env: { ...process.env, SESSIONS_DATA_DIR: dataDirectory },
    homeDirectory: environment.home,
  });
  const lifecycle = createSqliteIndexLifecycle({ platform });
  const clock = Object.freeze({ now: () => new Date() });

  const seedTimings = createIndexTimingCollector();
  const seedDelivery = createWorkspaceDeliveryTracker();
  let seedCohort: CohortSnapshot | undefined;
  const seed = await runStage("seed-index", () =>
    timeIndexOperation(seedTimings.recorder, "total", async () =>
      runIndex({
        paths: indexPaths,
        sources: [
          selectCohort(selected, preflight.signatures, cursorPaths, seedDelivery, (value) => {
            seedCohort = value;
          }),
        ],
        sourceSelection: "required",
        lifecycle,
        clock,
        signal,
        timing: seedTimings.recorder,
      }),
    ),
  );
  const afterSeed = await runStage("provider-stability", () =>
    captureSelectedCohort(requireCohort(seedCohort).candidates, cursorPaths),
  );

  const stableTimings = createIndexTimingCollector();
  const stableDelivery = createWorkspaceDeliveryTracker();
  let stableCohort: CohortSnapshot | undefined;
  const stable = await runStage("stable-index", () =>
    timeIndexOperation(stableTimings.recorder, "total", async () =>
      runIndex({
        paths: indexPaths,
        sources: [
          selectCohort(selected, preflight.signatures, cursorPaths, stableDelivery, (value) => {
            stableCohort = value;
          }),
        ],
        sourceSelection: "required",
        lifecycle,
        clock,
        signal,
        timing: stableTimings.recorder,
      }),
    ),
  );
  const afterStable = await runStage("provider-stability", () =>
    captureSelectedCohort(requireCohort(stableCohort).candidates, cursorPaths),
  );

  const seedSnapshot = requireCohort(seedCohort);
  const stableSnapshot = requireCohort(stableCohort);
  const cohortEqual = sameStrings(
    seedSnapshot.candidateSignatures,
    stableSnapshot.candidateSignatures,
  );
  const selectedProviderBytesEqual = sameFiles(
    preflight.files,
    seedSnapshot.files,
    afterSeed.files,
    stableSnapshot.files,
    afterStable.files,
  );
  await runStage("provider-stability", async () => {
    requireCondition(cohortEqual && selectedProviderBytesEqual);
  });
  await runStage("seed-admission", async () => {
    requireCompleteReport(seed, counts({ discovered: COHORT_SESSIONS, updated: COHORT_SESSIONS }));
    const delivery = seedDelivery.snapshot();
    const timings = seedTimings.snapshot();
    requireCondition(
      delivery.exactWorkspaceReference &&
        delivery.discoveryCalls >= 1 &&
        delivery.readCalls === COHORT_SESSIONS &&
        timings.phases.changedReadAndNormalize.calls === COHORT_SESSIONS,
    );
  });
  await runStage("stable-admission", async () => {
    requireCompleteReport(
      stable,
      counts({ discovered: COHORT_SESSIONS, unchanged: COHORT_SESSIONS }),
    );
    const delivery = stableDelivery.snapshot();
    const timings = stableTimings.snapshot();
    requireCondition(
      delivery.exactWorkspaceReference &&
        delivery.discoveryCalls >= 1 &&
        delivery.readCalls === 0 &&
        timings.phases.changedReadAndNormalize.calls === 0,
    );
  });

  const health = await runStage("library-health", () => lifecycle.inspectHealth(indexPaths));
  const cleanWriterState =
    health.ok &&
    health.writerLease === "free" &&
    (await writerCleanStateIsValid(indexPaths.database, platform));
  await runStage("library-health", async () => {
    requireCondition(cleanWriterState);
  });

  return Object.freeze({
    cohortSessions: COHORT_SESSIONS,
    cohortEqual,
    selectedProviderFiles: seedSnapshot.files.length,
    selectedProviderBytes: sumBytes(seedSnapshot.files),
    selectedProviderBytesEqual,
    preflightFailureTotals: preflight.failureTotals,
    seedComplete: true,
    seedCounts: seed.counts,
    stableComplete: true,
    stableCounts: stable.counts,
    libraryHealthy: true,
    cleanWriterState: true,
    workspaceDelivery: {
      seed: seedDelivery.snapshot(),
      stable: stableDelivery.snapshot(),
    },
    seedTimings: seedTimings.snapshot().phases,
    timings: stableTimings.snapshot().phases,
  });
}

async function writerCleanStateIsValid(
  databasePath: string,
  platform: SupportedPlatform,
): Promise<boolean> {
  const proof = await readWriterCleanProof(databasePath, { platform });
  if (proof === undefined) return false;
  const url = pathToFileURL(databasePath);
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");
  const database = new DatabaseSync(url.href, {
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

async function cleanupTemporaryRoot(): Promise<void> {
  const owned = temporaryRoot;
  if (owned === undefined) return;
  let stats: BigIntStats;
  try {
    stats = await lstat(owned.path, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  requireCondition(
    stats.isDirectory() &&
      stats.dev === owned.dev &&
      stats.ino === owned.ino &&
      (stats.mode & 0o777n) === 0o700n,
  );
  await rm(owned.path, { recursive: true, force: true });
}

async function preflightCohort(
  selected: SelectedSessionSource,
  paths: ResolvedCursorPaths,
  workspace: SourceCaptureWorkspace,
  signal: AbortSignal,
): Promise<PreflightResult> {
  const candidates: DiscoveredSession[] = [];
  for await (const candidate of selected.adapter.discover(workspace)) candidates.push(candidate);
  candidates.sort((left, right) =>
    compareBinaryStrings(left.identity.nativeId, right.identity.nativeId),
  );

  const inventory = await inventoryCursorSource(paths);
  const admitted: DiscoveredSession[] = [];
  const admittedSnapshots: CohortSnapshot[] = [];
  const failures = emptyFailureTotals();
  for (const candidate of candidates) {
    throwIfIndexInterrupted(signal);
    const before = await captureCohortWithInventory([candidate], paths, inventory);
    let readError: unknown;
    try {
      await readSessionDocument(selected.adapter, candidate, workspace);
    } catch (error) {
      readError = error;
    }
    const after = await captureCohortWithInventory([candidate], paths, inventory);
    requireCondition(sameFiles(before.files, after.files));
    if (readError !== undefined) {
      if (!isSourceFailureError(readError)) throw readError;
      failures[readError.failure.kind] += 1;
      continue;
    }
    admitted.push(candidate);
    admittedSnapshots.push(before);
    if (admitted.length === COHORT_SESSIONS) break;
  }
  requireCondition(admitted.length === COHORT_SESSIONS);
  const baseline = mergeCohortSnapshots(admitted, admittedSnapshots);
  const afterPreflight = await captureSelectedCohort(admitted, paths);
  requireCondition(
    sameStrings(baseline.candidateSignatures, afterPreflight.candidateSignatures) &&
      sameFiles(baseline.files, afterPreflight.files),
  );
  return Object.freeze({
    signatures: baseline.candidateSignatures,
    files: baseline.files,
    failureTotals: Object.freeze({ ...failures }),
  });
}

function selectCohort(
  selected: SelectedSessionSource,
  signatures: readonly string[],
  paths: ResolvedCursorPaths,
  delivery: WorkspaceDeliveryTracker,
  capture: (snapshot: CohortSnapshot) => void,
): SelectedSessionSource {
  const expected = new Set(signatures);
  const adapter: SessionSource = Object.freeze({
    kind: selected.adapter.kind,
    ...(selected.adapter.canReplace === undefined
      ? {}
      : {
          canReplace: (previous: string, next: string) =>
            selected.adapter.canReplace?.(previous, next) === true,
        }),
    probe: () => selected.adapter.probe(),
    async *discover(workspace: SourceCaptureWorkspace): AsyncIterable<DiscoveredSession> {
      delivery.recordDiscovery(workspace);
      const matches = new Map<string, DiscoveredSession>();
      for await (const candidate of selected.adapter.discover(workspace)) {
        const signature = candidateSignature(candidate);
        if (expected.has(signature)) matches.set(signature, candidate);
      }
      const cohort = signatures.map((signature) => requireCandidate(matches.get(signature)));
      capture(await captureSelectedCohort(cohort, paths));
      yield* cohort;
    },
    read(candidate: DiscoveredSession, workspace: SourceCaptureWorkspace) {
      delivery.recordRead(workspace);
      return selected.adapter.read(candidate, workspace);
    },
  });
  return Object.freeze({ instance: selected.instance, adapter });
}

async function captureSelectedCohort(
  candidates: readonly DiscoveredSession[],
  paths: ResolvedCursorPaths,
): Promise<CohortSnapshot> {
  const inventory = await inventoryCursorSource(paths);
  return captureCohortWithInventory(candidates, paths, inventory);
}

async function captureCohortWithInventory(
  candidates: readonly DiscoveredSession[],
  paths: ResolvedCursorPaths,
  inventory: CursorStructuralInventory,
): Promise<CohortSnapshot> {
  const descriptors = selectedDescriptors(candidates, inventory);
  const files: ProviderFileSnapshot[] = [];
  for (const descriptor of descriptors) {
    files.push(await snapshotRegularFile(paths.cursorHome, descriptor));
  }
  return Object.freeze({
    candidates: Object.freeze([...candidates]),
    candidateSignatures: Object.freeze(candidates.map(candidateSignature)),
    files: Object.freeze(files),
  });
}

function mergeCohortSnapshots(
  candidates: readonly DiscoveredSession[],
  snapshots: readonly CohortSnapshot[],
): CohortSnapshot {
  const files = new Map<string, ProviderFileSnapshot>();
  for (const snapshot of snapshots) {
    for (const file of snapshot.files) {
      const previous = files.get(file.key);
      if (previous === undefined) files.set(file.key, file);
      else requireCondition(sameFiles([previous], [file]));
    }
  }
  return Object.freeze({
    candidates: Object.freeze([...candidates]),
    candidateSignatures: Object.freeze(candidates.map(candidateSignature)),
    files: Object.freeze([...files.values()]),
  });
}

function selectedDescriptors(
  candidates: readonly DiscoveredSession[],
  inventory: CursorStructuralInventory,
): readonly CursorEntryDescriptor[] {
  const descriptors = new Map<string, CursorEntryDescriptor>();
  const add = (descriptor: CursorEntryDescriptor): void => {
    if (descriptor.kind !== "regular-file") return;
    descriptors.set(componentKey(descriptor.components), descriptor);
  };
  const addStore = (store: CursorSqliteInventory): void => {
    add(store.main);
    add(store.wal);
  };

  for (const candidate of candidates) {
    const family = candidateFamily(candidate);
    if (family === "chat-store-v1") {
      const matches = inventory.chats.filter(
        (chat) => chat.nativeId === candidate.identity.nativeId,
      );
      requireCondition(matches.length === 1 && matches[0]?.metadata !== undefined);
      add(matches[0]!.metadata!.descriptor);
      addStore(matches[0]!.store);
      continue;
    }
    if (family === "agent-checkpoint-store-v1") {
      const directoryName = cursorAgentStoreDirectory(candidate.identity.nativeId);
      const matches = inventory.catalogs.flatMap((catalog) =>
        catalog.stores
          .filter((store) => store.directoryName === directoryName)
          .map((store) => ({ catalog, store })),
      );
      requireCondition(matches.length === 1);
      addStore(matches[0]!.catalog.catalog);
      addStore(matches[0]!.store.store);
      continue;
    }
    requireCondition(
      family === "agent-transcript-jsonl-v1" || family === "agent-transcript-conflict-v1",
    );
    const matches = inventory.agentTranscripts.filter(
      (transcript) => transcript.nativeId === candidate.identity.nativeId,
    );
    requireCondition(
      family === "agent-transcript-jsonl-v1" ? matches.length === 1 : matches.length > 1,
    );
    for (const match of matches) add(match.file);
  }
  return [...descriptors.values()].toSorted((left, right) =>
    compareComponentArrays(left.components, right.components),
  );
}

function candidateFamily(candidate: DiscoveredSession): string {
  const uri = candidate.inputs[0]?.locator.uri;
  const match = uri === undefined ? undefined : /^cursor:\/\/session\/([^/]+)\//u.exec(uri);
  requireCondition(match?.[1] !== undefined);
  return match[1];
}

async function snapshotRegularFile(
  root: string,
  descriptor: CursorEntryDescriptor,
): Promise<ProviderFileSnapshot> {
  const file = cursorPath(root, descriptor.components);
  const before = await lstat(file, { bigint: true });
  requireCondition(before.isFile());
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let digest: string | undefined;
  let size = 0;
  let operationError: unknown;
  try {
    requireCondition(sameStat(before, await handle.stat({ bigint: true })));
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(FILE_BUFFER_BYTES);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, size);
      if (bytesRead === 0) break;
      size = addSafeInteger(size, bytesRead);
      hash.update(buffer.subarray(0, bytesRead));
    }
    requireCondition(size === safeBytes(before.size));
    requireCondition(sameStat(before, await handle.stat({ bigint: true })));
    requireCondition(sameStat(before, await lstat(file, { bigint: true })));
    digest = hash.digest("hex");
  } catch (error) {
    operationError = error;
  }
  let closeError: unknown;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  if (operationError !== undefined || closeError !== undefined || digest === undefined) {
    throw operationError ?? closeError ?? new Error("Cursor provider snapshot failed");
  }
  return Object.freeze({ key: componentKey(descriptor.components), size, digest });
}

function createCaptureWorkspace(privateRoot: string): SourceCaptureWorkspace {
  return Object.freeze({
    async withPrivateDirectory<T>(operation: (directory: string) => Promise<T>): Promise<T> {
      const directory = await mkdtemp(path.join(privateRoot, "attempt-"));
      try {
        return await operation(directory);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  });
}

function createWorkspaceDeliveryTracker(): WorkspaceDeliveryTracker {
  let expected: SourceCaptureWorkspace | undefined;
  let discoveryCalls = 0;
  let readCalls = 0;
  let exact = true;
  const record = (workspace: SourceCaptureWorkspace): void => {
    if (expected === undefined) expected = workspace;
    else exact &&= expected === workspace;
  };
  return Object.freeze({
    recordDiscovery(workspace: SourceCaptureWorkspace): void {
      discoveryCalls += 1;
      record(workspace);
    },
    recordRead(workspace: SourceCaptureWorkspace): void {
      readCalls += 1;
      record(workspace);
    },
    snapshot(): WorkspaceDeliverySnapshot {
      return {
        discoveryCalls,
        readCalls,
        exactWorkspaceReference: expected !== undefined && exact,
      };
    },
  });
}

function requireCompleteReport(report: IndexReport, expected: IndexReport["counts"]): void {
  requireCondition(report.incompleteSources === 0 && report.omittedItemCount === 0);
  requireCondition(report.sources.length === 1);
  const source = report.sources[0];
  requireCondition(
    source?.status === "completed" &&
      source.coverage.status === "complete" &&
      source.items.length === 0 &&
      source.omittedItemCount === 0,
  );
  requireCondition(sameCounts(report.counts, expected) && sameCounts(source.counts, expected));
}

function counts(overrides: Partial<IndexReport["counts"]>): IndexReport["counts"] {
  return { discovered: 0, unchanged: 0, updated: 0, failed: 0, missing: 0, stale: 0, ...overrides };
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

function emptyFailureTotals(): Record<PreflightFailureKind, number> {
  return {
    unavailable: 0,
    unreadable: 0,
    malformed: 0,
    "source-changed": 0,
    "unsupported-format": 0,
  };
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

function componentKey(components: readonly string[]): string {
  return JSON.stringify(components);
}

function compareComponentArrays(left: readonly string[], right: readonly string[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const compared = compareCursorComponents(left[index]!, right[index]!);
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}

function sameFiles(...snapshots: readonly (readonly ProviderFileSnapshot[])[]): boolean {
  const normalized = snapshots.map((files) =>
    JSON.stringify([...files].toSorted((left, right) => compareBinaryStrings(left.key, right.key))),
  );
  return normalized.every((value) => value === normalized[0]);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sumBytes(files: readonly ProviderFileSnapshot[]): number {
  return files.reduce((sum, file) => addSafeInteger(sum, file.size), 0);
}

function sameStat(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isFile() === right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function safeBytes(value: bigint): number {
  const bytes = Number(value);
  requireCondition(Number.isSafeInteger(bytes) && bytes >= 0 && BigInt(bytes) === value);
  return bytes;
}

function addSafeInteger(left: number, right: number): number {
  const value = left + right;
  requireCondition(Number.isSafeInteger(value) && value >= 0);
  return value;
}

function requireCohort(value: CohortSnapshot | undefined): CohortSnapshot {
  requireCondition(value !== undefined);
  return value;
}

function requireCandidate(value: DiscoveredSession | undefined): DiscoveredSession {
  requireCondition(value !== undefined);
  return value;
}

function admitInvocation(argv: readonly string[], platform: string): SupportedPlatform {
  const admitted = argv[0] === "--" ? argv.slice(1) : argv;
  if (admitted.length !== 1 || admitted[0] !== ACKNOWLEDGEMENT) {
    throw new MeasurementFailure("acknowledgement-required");
  }
  if (platform !== "darwin" && platform !== "linux") {
    throw new MeasurementFailure("unsupported-platform");
  }
  return platform;
}

async function runStage<T>(stage: MeasurementStage, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof MeasurementFailure || error instanceof MeasurementStageFailure)
      throw error;
    throw new MeasurementStageFailure(stage, error);
  }
}

function failureMessage(error: unknown): string {
  if (error instanceof MeasurementFailure) {
    return error.code === "acknowledgement-required"
      ? `sessions: Cursor indexing measurement requires exactly ${ACKNOWLEDGEMENT}.\n`
      : "sessions: Cursor indexing measurement is supported only on macOS and Linux.\n";
  }
  if (error instanceof MeasurementStageFailure) {
    return `sessions: Cursor indexing measurement failed at ${error.stage}. An uncatchable process or machine failure can leave private temporary residue.\n`;
  }
  return RESIDUE_WARNING;
}

function requireCondition(condition: unknown): asserts condition {
  if (!condition) throw new Error("Cursor indexing measurement invariant failed");
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
