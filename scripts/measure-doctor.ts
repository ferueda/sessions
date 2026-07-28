import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createDiscoveredSession } from "../src/application/source-input-fingerprint.ts";
import type { IndexPaths } from "../src/application/ports/index-lifecycle.ts";
import {
  admitSessionObservation,
  admitSessionReplacement,
  type ValidatedSessionReplacement,
} from "../src/application/validate-session.ts";
import { hashContent } from "../src/domain/content-hash.ts";
import type {
  SessionDocument,
  SessionEntry,
  SessionIdentity,
  SourceInstance,
} from "../src/domain/session.ts";
import { createSqliteIndexLifecycle } from "../src/infrastructure/sqlite/database.ts";
import { resolveIndexPaths } from "../src/infrastructure/state/paths.ts";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const FAILURE_MESSAGE = "Doctor feasibility measurement failed\n";
const PRIVATE_CANARY = "doctor-measurement-private-canary";
const GENERATED_AT = "2026-07-23T12:00:00.000Z";
const FINISHED_AT = "2026-07-23T12:01:00.000Z";
const CLOSED_AT = "2026-07-23T12:02:00.000Z";
const WRITER_TOKEN = "doctor-measurement-writer";
const FTS_VOCAB_TABLE = "sessions_measure_actual_vocab";
const AUTHORITY_MARKER = ".doctor-measurement-authority";
const PRODUCTION_BYTE_INTERVAL_TARGET = 16 * 1024 * 1024;
const CONTRACT_SMALL_BYTE_TARGET = 64 * 1024;
const CONTRACT_LARGE_BYTE_TARGET = 128 * 1024;
const STRATEGIES = ["one", "two", "many"] as const;
const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

type StrategyName = (typeof STRATEGIES)[number];
type CohortName = "small" | "large";
type WorkerMode = "seed" | "equality" | "measure" | "health";

interface CohortConfiguration {
  readonly name: CohortName;
  readonly uniqueValues: number;
  readonly manyIntervals: number;
  readonly rowIntervalTarget: number;
  readonly byteIntervalTarget: number;
  readonly repeatedTermTarget: number;
}

interface ContentRow {
  readonly contentId: number;
  readonly bytes: number;
}

interface DocumentInterval {
  readonly lowerExclusive: number;
  readonly upperInclusive: number;
}

interface SeedWorkerReport {
  readonly contentRows: number;
  readonly contentBytes: number;
  readonly entryRows: number;
  readonly instanceRows: number;
  readonly repeatedTermInstances: number;
  readonly oversizedContentRows: number;
  readonly zeroTokenContentRows: number;
}

interface EqualityStrategyReport {
  readonly name: StrategyName;
  readonly intervalCount: number;
  readonly intervals: readonly DocumentInterval[];
  readonly coordinateEquality: boolean;
  readonly termSummaryEquality: boolean;
  readonly docsizeCoverage: boolean;
  readonly finalTailEmpty: boolean;
}

interface EqualityWorkerReport {
  readonly contentRows: number;
  readonly instanceRows: number;
  readonly termCount: number;
  readonly strategies: readonly EqualityStrategyReport[];
}

interface PlanAggregate {
  readonly rows: number;
  readonly virtualTableScans: number;
  readonly temporaryBtrees: number;
}

interface PlanShapeReport {
  readonly unbounded: PlanAggregate;
  readonly prefix: PlanAggregate;
  readonly middle: PlanAggregate;
  readonly tail: PlanAggregate;
  readonly prefixDiffersFromUnbounded: boolean;
  readonly middleDiffersFromUnbounded: boolean;
  readonly tailDiffersFromUnbounded: boolean;
}

interface ProbePlanReport {
  readonly rawInstances: PlanShapeReport;
  readonly termSummaries: PlanShapeReport;
}

interface MeasureWorkerReport {
  readonly strategy: StrategyName;
  readonly intervalCount: number;
  readonly queriesPerShape: number;
  readonly instanceRows: number;
  readonly termSummaryRows: number;
  readonly phases: {
    readonly rawInstancesMs: number;
    readonly termSummariesMs: number;
    readonly totalMs: number;
  };
  readonly peakRssBytes: number;
  readonly memoryOnlyTemp: boolean;
  readonly tempCleanup: boolean;
  readonly plans: ProbePlanReport;
}

interface HealthWorkerReport {
  readonly healthy: boolean;
}

interface NumericAggregate {
  readonly samples: readonly number[];
  readonly median: number;
  readonly p95: number;
}

interface RssAggregate {
  readonly samples: readonly number[];
  readonly max: number;
}

interface StrategyMeasurementReport {
  readonly name: StrategyName;
  readonly intervalCount: number;
  readonly bounds: {
    readonly firstLowerExclusive: number;
    readonly lastUpperInclusive: number;
    readonly minimumIdSpan: number;
    readonly maximumIdSpan: number;
  };
  readonly queriesPerShape: number;
  readonly instanceRows: number;
  readonly termSummaryRows: number;
  readonly phases: {
    readonly rawInstancesMs: NumericAggregate;
    readonly termSummariesMs: NumericAggregate;
    readonly totalMs: NumericAggregate;
  };
  readonly peakRssBytes: RssAggregate;
}

interface CohortReport {
  readonly name: CohortName;
  readonly corpus: {
    readonly sessions: number;
    readonly entries: number;
    readonly contentRows: number;
    readonly contentBytes: number;
    readonly instanceRows: number;
    readonly repeatedTermTarget: number;
    readonly repeatedTermInstances: number;
    readonly rowIntervalTarget: number;
    readonly byteIntervalTarget: number;
    readonly oversizedContentRows: number;
    readonly zeroTokenContentRows: number;
    readonly databaseBytes: number;
  };
  readonly cloneEquality: boolean;
  readonly exactQueryEquality: boolean;
  readonly intervalAccounting: boolean;
  readonly finalHealth: boolean;
  readonly persistentFileStateEqual: boolean;
  readonly sidecarsAbsentBeforeAndAfter: boolean;
  readonly ownedPermissions: boolean;
  readonly plans: ProbePlanReport;
  readonly strategies: readonly StrategyMeasurementReport[];
  readonly scaling: {
    readonly twoToOneTotalRatio: number;
    readonly manyToOneTotalRatio: number;
    readonly manyToOneRawInstancesRatio: number;
    readonly manyToOneTermSummariesRatio: number;
    readonly manyToOnePeakRssRatio: number;
  };
}

interface MeasurementReport {
  readonly schemaVersion: 1;
  readonly command: "measure-doctor";
  readonly mode: "contract" | "full";
  readonly acceptance: "accepted-rejection";
  readonly configuration: {
    readonly timingRounds: number;
    readonly intervalStrategies: readonly StrategyName[];
    readonly peakRssUnit: "bytes";
    readonly generatedOnly: true;
    readonly productionDoctorUnchanged: true;
  };
  readonly cohorts: readonly CohortReport[];
  readonly temporaryCleanup: true;
}

interface FileSnapshot {
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
  readonly links: bigint;
  readonly size: bigint;
  readonly modified: bigint;
  readonly changed: bigint;
  readonly digest: string;
}

interface OwnedRoot {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
}

const workerRequested = process.argv.includes("--worker");
if (!workerRequested) {
  try {
    const report = await runController();
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch {
    process.stderr.write(FAILURE_MESSAGE);
    process.exitCode = 1;
  }
} else {
  try {
    const workerMode = requiredWorkerMode();
    const report = await runWorker(workerMode);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch {
    process.exitCode = 1;
  }
}

async function runController(): Promise<MeasurementReport> {
  assertControllerArguments();
  assert(process.platform !== "win32", "doctor feasibility measurement requires POSIX modes");
  const contract = process.argv.includes("--contract");
  const forceChildFailure = process.argv.includes("--force-child-failure");
  const configurations = cohortConfigurations(contract);
  const timingRounds = contract ? 2 : 3;
  const temporaryParent = process.env.SESSIONS_MEASURE_DOCTOR_TEMP_PARENT ?? tmpdir();
  const ownedRoot = await createMeasurementRoot(temporaryParent);
  const rootPath = ownedRoot.path;
  let report: MeasurementReport | undefined;
  let operationFailure: unknown;
  let cleanupFailure: unknown;

  try {
    const capability = randomBytes(32).toString("hex");
    await createWorkerAuthority(rootPath, capability);
    const cohorts: CohortReport[] = [];
    for (const configuration of configurations) {
      cohorts.push(
        await measureCohort(rootPath, configuration, {
          capability,
          contract,
          forceChildFailure,
          timingRounds,
        }),
      );
    }
    assert(
      await hasMode(path.join(rootPath, AUTHORITY_MARKER), 0o600),
      "measurement authority permissions changed",
    );
    report = {
      schemaVersion: 1,
      command: "measure-doctor",
      mode: contract ? "contract" : "full",
      acceptance: "accepted-rejection",
      configuration: {
        timingRounds,
        intervalStrategies: STRATEGIES,
        peakRssUnit: "bytes",
        generatedOnly: true,
        productionDoctorUnchanged: true,
      },
      cohorts,
      temporaryCleanup: true,
    };
  } catch (error) {
    operationFailure = error;
  } finally {
    try {
      await removeOwnedRoot(ownedRoot);
    } catch (error) {
      cleanupFailure = error;
    }
  }

  if (operationFailure !== undefined || cleanupFailure !== undefined) {
    throw new AggregateError(
      [operationFailure, cleanupFailure].filter((error) => error !== undefined),
      "doctor feasibility measurement did not complete",
    );
  }
  assert(report !== undefined, "doctor feasibility measurement produced no report");
  return report;
}

async function measureCohort(
  root: string,
  configuration: CohortConfiguration,
  options: {
    readonly capability: string;
    readonly contract: boolean;
    readonly forceChildFailure: boolean;
    readonly timingRounds: number;
  },
): Promise<CohortReport> {
  const cohortRoot = path.join(root, configuration.name);
  const seedDirectory = path.join(cohortRoot, "seed");
  await createOwnedDirectory(cohortRoot);
  await createOwnedDirectory(seedDirectory);
  const seedReport = readSeedWorkerReport(
    runChild("seed", seedDirectory, configuration, options.contract, {
      capability: options.capability,
      root,
    }),
  );
  const seedPaths = pathsAt(seedDirectory);
  await assertNoSidecars(seedPaths.database);
  const seedSnapshotBefore = await snapshotFile(seedPaths.database);
  const cloneDirectories = Object.fromEntries(
    STRATEGIES.map((strategy) => [strategy, path.join(cohortRoot, strategy)]),
  ) as Record<StrategyName, string>;
  const cloneSnapshots = {} as Record<StrategyName, FileSnapshot>;

  for (const strategy of STRATEGIES) {
    const directory = cloneDirectories[strategy];
    await createOwnedDirectory(directory);
    const paths = pathsAt(directory);
    await copyFile(seedPaths.database, paths.database);
    await chmod(paths.database, 0o600);
    await assertNoSidecars(paths.database);
    const snapshot = await snapshotFile(paths.database);
    assert.equal(snapshot.digest, seedSnapshotBefore.digest, "measurement clone bytes changed");
    assert.equal(snapshot.size, seedSnapshotBefore.size, "measurement clone size changed");
    cloneSnapshots[strategy] = snapshot;
  }

  const equality = readEqualityWorkerReport(
    runChild("equality", seedDirectory, configuration, options.contract, {
      capability: options.capability,
      root,
    }),
  );
  assert.equal(equality.contentRows, seedReport.contentRows, "equality content count changed");
  assert.equal(equality.instanceRows, seedReport.instanceRows, "equality instance count changed");
  assert.deepStrictEqual(
    equality.strategies.map(({ name }) => name),
    STRATEGIES,
    "equality strategy order changed",
  );

  const samples = Object.fromEntries(
    STRATEGIES.map((strategy) => [strategy, [] as MeasureWorkerReport[]]),
  ) as Record<StrategyName, MeasureWorkerReport[]>;
  let commonPlans: ProbePlanReport | undefined;
  let failureInjected = false;
  for (let round = 0; round < options.timingRounds; round += 1) {
    for (const strategy of rotateStrategies(round)) {
      const shouldFail: boolean =
        options.forceChildFailure && configuration.name === "small" && !failureInjected;
      failureInjected ||= shouldFail;
      const raw = runChild("measure", cloneDirectories[strategy], configuration, options.contract, {
        capability: options.capability,
        root,
        strategy,
        forceFailure: shouldFail,
      });
      const measurement = readMeasureWorkerReport(raw);
      assert.equal(measurement.strategy, strategy, "measurement strategy changed");
      assert.equal(
        measurement.intervalCount,
        expectedIntervalCount(configuration, strategy),
        "measurement interval count changed",
      );
      assert.equal(
        measurement.instanceRows,
        equality.instanceRows,
        "measurement skipped or duplicated FTS instances",
      );
      assert(measurement.memoryOnlyTemp, "measurement TEMP storage was not memory-only");
      assert(measurement.tempCleanup, "measurement TEMP objects were not removed");
      if (commonPlans === undefined) commonPlans = measurement.plans;
      else assert.deepStrictEqual(measurement.plans, commonPlans, "measurement plan changed");
      samples[strategy].push(measurement);
    }
  }
  assert(
    !options.forceChildFailure || failureInjected,
    "forced doctor measurement failure was not injected",
  );
  assert(commonPlans !== undefined, "doctor measurement captured no query plan");

  let fileStateEqual = true;
  let sidecarsAbsent = true;
  let ownedPermissions =
    (await hasMode(root, 0o700)) &&
    (await hasMode(path.join(root, AUTHORITY_MARKER), 0o600)) &&
    (await hasMode(cohortRoot, 0o700)) &&
    (await hasMode(seedDirectory, 0o700));
  for (const strategy of STRATEGIES) {
    const paths = pathsAt(cloneDirectories[strategy]);
    const after = await snapshotFile(paths.database);
    fileStateEqual &&= sameFileSnapshot(cloneSnapshots[strategy], after);
    sidecarsAbsent &&= await sidecarsAreAbsent(paths.database);
    ownedPermissions &&= await hasMode(cloneDirectories[strategy], 0o700);
    ownedPermissions &&= await hasMode(paths.database, 0o600);
  }

  const seedSnapshotBeforeHealth = await snapshotFile(seedPaths.database);
  const health = readHealthWorkerReport(
    runChild("health", seedDirectory, configuration, options.contract, {
      capability: options.capability,
      root,
    }),
  );
  const seedSnapshotAfterHealth = await snapshotFile(seedPaths.database);
  fileStateEqual &&= sameFileSnapshot(seedSnapshotBefore, seedSnapshotAfterHealth);
  fileStateEqual &&= sameFileSnapshot(seedSnapshotBeforeHealth, seedSnapshotAfterHealth);
  sidecarsAbsent &&= await sidecarsAreAbsent(seedPaths.database);
  ownedPermissions &&= await hasMode(seedPaths.database, 0o600);

  const strategies = STRATEGIES.map((strategy) => {
    const equalityStrategy = equality.strategies.find((candidate) => candidate.name === strategy);
    assert(equalityStrategy !== undefined, "doctor equality strategy is absent");
    return summarizeStrategy(strategy, samples[strategy], equalityStrategy);
  });
  const one = strategies[0]!;
  const two = strategies[1]!;
  const many = strategies[2]!;
  const exactQueryEquality = equality.strategies.every(
    (strategy) => strategy.coordinateEquality && strategy.termSummaryEquality,
  );
  const intervalAccounting = equality.strategies.every(
    (strategy) =>
      strategy.docsizeCoverage &&
      strategy.finalTailEmpty &&
      strategy.intervalCount === strategy.intervals.length,
  );
  assert(exactQueryEquality, "doctor measurement exact query equality failed");
  assert(intervalAccounting, "doctor measurement interval accounting failed");
  assert(health.healthy, "doctor measurement final health failed");
  assert(fileStateEqual, "doctor measurement changed persistent database state");
  assert(sidecarsAbsent, "doctor measurement retained a SQLite sidecar");
  assert(ownedPermissions, "doctor measurement ownership permissions changed");

  return {
    name: configuration.name,
    corpus: {
      sessions: 1,
      entries: seedReport.entryRows,
      contentRows: seedReport.contentRows,
      contentBytes: seedReport.contentBytes,
      instanceRows: seedReport.instanceRows,
      repeatedTermTarget: configuration.repeatedTermTarget,
      repeatedTermInstances: seedReport.repeatedTermInstances,
      rowIntervalTarget: configuration.rowIntervalTarget,
      byteIntervalTarget: configuration.byteIntervalTarget,
      oversizedContentRows: seedReport.oversizedContentRows,
      zeroTokenContentRows: seedReport.zeroTokenContentRows,
      databaseBytes: safeNumber(seedSnapshotBefore.size),
    },
    cloneEquality: true,
    exactQueryEquality,
    intervalAccounting,
    finalHealth: health.healthy,
    persistentFileStateEqual: fileStateEqual,
    sidecarsAbsentBeforeAndAfter: sidecarsAbsent,
    ownedPermissions,
    plans: commonPlans,
    strategies,
    scaling: {
      twoToOneTotalRatio: ratio(two.phases.totalMs.median, one.phases.totalMs.median),
      manyToOneTotalRatio: ratio(many.phases.totalMs.median, one.phases.totalMs.median),
      manyToOneRawInstancesRatio: ratio(
        many.phases.rawInstancesMs.median,
        one.phases.rawInstancesMs.median,
      ),
      manyToOneTermSummariesRatio: ratio(
        many.phases.termSummariesMs.median,
        one.phases.termSummariesMs.median,
      ),
      manyToOnePeakRssRatio: ratio(many.peakRssBytes.max, one.peakRssBytes.max),
    },
  };
}

function runChild(
  mode: WorkerMode,
  directory: string,
  configuration: CohortConfiguration,
  contract: boolean,
  options: {
    readonly capability: string;
    readonly root: string;
    readonly strategy?: StrategyName;
    readonly forceFailure?: boolean;
  },
): unknown {
  const arguments_ = [
    SCRIPT_PATH,
    "--worker",
    mode,
    "--directory",
    directory,
    "--root",
    options.root,
    "--capability",
    options.capability,
    "--cohort",
    configuration.name,
  ];
  if (contract) arguments_.push("--contract");
  if (options.strategy !== undefined) arguments_.push("--strategy", options.strategy);
  if (options.forceFailure === true) arguments_.push("--fail-after-open");

  const result = spawnSync(process.execPath, arguments_, {
    cwd: directory,
    encoding: "utf8",
    env: isolatedWorkerEnvironment(directory),
    maxBuffer: 16 * 1024 * 1024,
    timeout: contract ? 30_000 : 10 * 60_000,
  });
  if (result.status !== 0 || result.signal !== null || result.stderr !== "") {
    throw new Error("doctor feasibility worker failed");
  }
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 1, "doctor feasibility worker emitted unexpected output");
  return JSON.parse(lines[0]!);
}

function isolatedWorkerEnvironment(directory: string): NodeJS.ProcessEnv {
  const isolatedHome = path.join(directory, "isolated-home");
  return {
    ...process.env,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    CODEX_HOME: path.join(directory, "unavailable-codex"),
    CODEX_SQLITE_HOME: undefined,
    SESSIONS_DATA_DIR: undefined,
    SESSIONS_MEASURE_DOCTOR_TEMP_PARENT: undefined,
  };
}

async function runWorker(mode: WorkerMode): Promise<unknown> {
  assertWorkerArguments(mode);
  const directory = requiredOption("--directory");
  const root = requiredOption("--root");
  const capability = requiredOption("--capability");
  await assertWorkerAuthority(root, directory, capability);
  const configuration = configurationFor(
    process.argv.includes("--contract"),
    requiredOption("--cohort"),
  );
  if (mode === "seed") {
    await assertSeedDirectoryEmpty(directory);
    return seedWorker(directory, configuration);
  }
  if (mode === "equality") return equalityWorker(directory, configuration);
  if (mode === "health") return healthWorker(directory);
  return measureWorker(
    directory,
    configuration,
    requiredStrategy(requiredOption("--strategy")),
    process.argv.includes("--fail-after-open"),
  );
}

async function seedWorker(
  directory: string,
  configuration: CohortConfiguration,
): Promise<SeedWorkerReport> {
  const paths = pathsAt(directory);
  const lifecycle = measurementLifecycle();
  const writer = await lifecycle.openWriter(paths);
  let operationFailure: unknown;
  try {
    const run = await writer.sessions.startRun({
      source: sourceFor(configuration),
      startedAt: GENERATED_AT,
    });
    await writer.sessions.replaceSession(run, replacementFor(configuration));
    const result = await writer.sessions.finishRun(run, {
      status: "completed",
      finishedAt: FINISHED_AT,
    });
    assert.deepStrictEqual(result.counts, {
      discovered: 1,
      unchanged: 0,
      updated: 1,
      failed: 0,
      missing: 0,
      stale: 0,
    });
  } catch (error) {
    operationFailure = error;
  }
  let closeFailure: unknown;
  try {
    await writer.close();
  } catch (error) {
    closeFailure = error;
  }
  if (operationFailure !== undefined || closeFailure !== undefined) {
    throw new AggregateError(
      [operationFailure, closeFailure].filter((error) => error !== undefined),
      "doctor measurement seed failed",
    );
  }
  await chmod(paths.database, 0o600);
  await assertNoSidecars(paths.database);
  return inspectSeededCorpus(paths.database, configuration);
}

async function inspectSeededCorpus(
  databasePath: string,
  configuration: CohortConfiguration,
): Promise<SeedWorkerReport> {
  const database = openImmutableDatabase(databasePath);
  try {
    configureMemoryTemp(database);
    createActualVocab(database);
    const content = database
      .prepare(
        `SELECT COUNT(*) AS rows,
                COALESCE(SUM(length(CAST(text AS BLOB))), 0) AS bytes,
                COALESCE(SUM(
                  CASE WHEN length(CAST(text AS BLOB)) > ? THEN 1 ELSE 0 END
                ), 0) AS oversized
         FROM sessions_content_values`,
      )
      .get(configuration.byteIntervalTarget) as Record<string, unknown> | undefined;
    const entries = database.prepare("SELECT COUNT(*) AS rows FROM sessions_entries").get() as
      | Record<string, unknown>
      | undefined;
    const instances = database
      .prepare(`SELECT COUNT(*) AS rows FROM temp.${FTS_VOCAB_TABLE}`)
      .get() as Record<string, unknown> | undefined;
    const repeated = database
      .prepare(`SELECT COUNT(*) AS rows FROM temp.${FTS_VOCAB_TABLE} WHERE term = ?`)
      .get("repeated") as Record<string, unknown> | undefined;
    const indexedDocuments = database.prepare(
      `SELECT DISTINCT doc FROM temp.${FTS_VOCAB_TABLE} ORDER BY doc`,
    );
    indexedDocuments.setReadBigInts(true);
    const indexedDocumentCount = indexedDocuments.all().length;
    const contentRows = integerNumber(content?.rows);
    const report = {
      contentRows,
      contentBytes: integerNumber(content?.bytes),
      entryRows: integerNumber(entries?.rows),
      instanceRows: integerNumber(instances?.rows),
      repeatedTermInstances: integerNumber(repeated?.rows),
      oversizedContentRows: integerNumber(content?.oversized),
      zeroTokenContentRows: contentRows - indexedDocumentCount,
    };
    assert(
      report.repeatedTermInstances > configuration.repeatedTermTarget,
      "generated repeated term did not cross the measurement target",
    );
    assert.equal(report.oversizedContentRows, 1, "generated oversized content count changed");
    assert(report.zeroTokenContentRows >= 2, "generated zero-token content is absent");
    return report;
  } finally {
    dropActualVocab(database);
    database.close();
  }
}

async function equalityWorker(
  directory: string,
  configuration: CohortConfiguration,
): Promise<EqualityWorkerReport> {
  const database = openImmutableDatabase(pathsAt(directory).database);
  try {
    configureMemoryTemp(database);
    createActualVocab(database);
    const contentRows = readContentRows(database);
    const contentIds = contentRows.map(({ contentId }) => contentId);
    const instanceRows = countRows(
      database,
      `SELECT COUNT(*) AS rows FROM temp.${FTS_VOCAB_TABLE}`,
    );
    const referenceSummaries = readTermSummaries(database);
    const strategies = STRATEGIES.map((name) => {
      const intervals = intervalsForStrategy(contentRows, configuration, name);
      return {
        name,
        intervalCount: intervals.length,
        intervals,
        coordinateEquality: coordinatesMatch(database, intervals),
        termSummaryEquality: termSummariesMatch(database, intervals, referenceSummaries),
        docsizeCoverage: docsizeCoverageIsExact(database, contentIds, intervals),
        finalTailEmpty: finalTailIsEmpty(database, intervals),
      };
    });
    assert(
      strategies.every(
        (strategy) =>
          strategy.coordinateEquality &&
          strategy.termSummaryEquality &&
          strategy.docsizeCoverage &&
          strategy.finalTailEmpty,
      ),
      "document interval equality failed",
    );
    return {
      contentRows: contentIds.length,
      instanceRows,
      termCount: referenceSummaries.size,
      strategies,
    };
  } finally {
    dropActualVocab(database);
    database.close();
  }
}

async function measureWorker(
  directory: string,
  configuration: CohortConfiguration,
  strategy: StrategyName,
  failAfterOpen: boolean,
): Promise<MeasureWorkerReport> {
  const database = openImmutableDatabase(pathsAt(directory).database);
  let memoryOnlyTemp = false;
  let tempCleanup = false;
  try {
    configureMemoryTemp(database);
    memoryOnlyTemp = true;
    createActualVocab(database);
    if (failAfterOpen) throw new Error("forced doctor measurement failure");
    const intervals = intervalsForStrategy(readContentRows(database), configuration, strategy);
    const plans = readProbePlans(database, intervals);
    const totalStartedAt = performance.now();
    const rawStartedAt = performance.now();
    const instanceRows = consumeInstanceQueries(database, intervals);
    const rawInstancesMs = performance.now() - rawStartedAt;
    const summariesStartedAt = performance.now();
    const termSummaryRows = consumeTermSummaryQueries(database, intervals);
    const termSummariesMs = performance.now() - summariesStartedAt;
    const totalMs = performance.now() - totalStartedAt;
    assert(finalTailIsEmpty(database, intervals), "measurement final FTS tail was not empty");
    dropActualVocab(database);
    tempCleanup = actualVocabIsAbsent(database);
    const maxRssKiB = process.resourceUsage().maxRSS;
    assert(Number.isSafeInteger(maxRssKiB) && maxRssKiB > 0, "worker peak RSS is invalid");
    return {
      strategy,
      intervalCount: intervals.length,
      queriesPerShape: intervals.length + 1,
      instanceRows,
      termSummaryRows,
      phases: {
        rawInstancesMs: roundMeasurement(rawInstancesMs),
        termSummariesMs: roundMeasurement(termSummariesMs),
        totalMs: roundMeasurement(totalMs),
      },
      peakRssBytes: maxRssKiB * 1024,
      memoryOnlyTemp,
      tempCleanup,
      plans,
    };
  } finally {
    if (!tempCleanup) dropActualVocab(database);
    database.close();
  }
}

async function healthWorker(directory: string): Promise<HealthWorkerReport> {
  const paths = pathsAt(directory);
  const health = await measurementLifecycle().inspectHealth(paths);
  assert(health.ok, "generated doctor measurement library is not healthy");
  return { healthy: true };
}

function measurementLifecycle() {
  return createSqliteIndexLifecycle({
    now: () => new Date(CLOSED_AT),
    writerToken: () => WRITER_TOKEN,
  });
}

function replacementFor(configuration: CohortConfiguration): ValidatedSessionReplacement {
  const identity = identityFor(configuration);
  const candidate = createDiscoveredSession({
    identity,
    inputs: [
      {
        role: "transcript",
        locator: { uri: `memory://${PRIVATE_CANARY}/${configuration.name}` },
        fingerprint: `revision-${configuration.name}`,
      },
    ],
    adapterVersion: "synthetic-doctor-measurement-v1",
  });
  const observation = admitSessionObservation(candidate);
  assert(observation.ok, "generated doctor measurement observation was rejected");
  const replacement = admitSessionReplacement(observation.observation, documentFor(configuration));
  assert(replacement.ok, "generated doctor measurement document was rejected");
  return replacement.replacement;
}

function documentFor(configuration: CohortConfiguration): SessionDocument {
  const identity = identityFor(configuration);
  const texts = [
    "shared generated doctor evidence",
    "shared generated doctor evidence",
    " \t\n ",
    "multibyte résumé 東京 evidence",
    ...Array.from(
      { length: configuration.uniqueValues },
      (_, ordinal) =>
        `repeated generated evidence unique-${String(ordinal).padStart(6, "0")} ${PRIVATE_CANARY}`,
    ),
    "!".repeat(configuration.byteIntervalTarget + 1),
  ];
  return {
    identity,
    title: `Generated doctor measurement ${configuration.name}`,
    workspace: "/generated/doctor-measurement",
    createdAt: GENERATED_AT,
    updatedAt: GENERATED_AT,
    lineageCoverage: "complete",
    relations: [],
    entries: texts.map((text, ordinal) => entryFor(configuration, ordinal, text)),
  };
}

function entryFor(configuration: CohortConfiguration, ordinal: number, text: string): SessionEntry {
  return {
    ordinal,
    kind: "message",
    actor: ordinal % 2 === 0 ? "human" : "model",
    timestamp: GENERATED_AT,
    sourceLocator: {
      uri: `memory://${PRIVATE_CANARY}/${configuration.name}/entry/${String(ordinal)}`,
    },
    content: [
      {
        kind: "text",
        ordinal: 0,
        text,
        contentHash: hashContent(text),
        origin: "unknown",
        originConfidence: "high",
        sourceMetadata: { fixture: "generated-doctor-measurement" },
      },
    ],
  };
}

function identityFor(configuration: CohortConfiguration): SessionIdentity {
  return {
    source: sourceFor(configuration),
    nativeId: `generated-${configuration.name}`,
  };
}

function sourceFor(configuration: CohortConfiguration): SourceInstance {
  return {
    kind: "synthetic-measurement",
    instanceId: `doctor-${configuration.name}`,
  };
}

function readContentRows(database: DatabaseSync): readonly ContentRow[] {
  const statement = database.prepare(
    `SELECT content_id, length(CAST(text AS BLOB)) AS bytes
     FROM sessions_content_values
     ORDER BY content_id`,
  );
  statement.setReadBigInts(true);
  return (statement.all() as readonly Record<string, unknown>[]).map((row) => ({
    contentId: safeNumber(sqliteInteger(row.content_id)),
    bytes: safeNumber(sqliteInteger(row.bytes)),
  }));
}

function intervalsForStrategy(
  contentRows: readonly ContentRow[],
  configuration: CohortConfiguration,
  strategy: StrategyName,
): readonly DocumentInterval[] {
  const contentIds = contentRows.map(({ contentId }) => contentId);
  const intervals =
    strategy === "many"
      ? createAdmissionIntervals(
          contentRows,
          configuration.rowIntervalTarget,
          configuration.byteIntervalTarget,
        )
      : createEqualIntervals(contentIds, expectedIntervalCount(configuration, strategy));
  assert.equal(
    intervals.length,
    expectedIntervalCount(configuration, strategy),
    "doctor measurement admission interval count changed",
  );
  return intervals;
}

function createEqualIntervals(
  contentIds: readonly number[],
  requestedCount: number,
): readonly DocumentInterval[] {
  assert(contentIds.length > 0, "doctor measurement content IDs are empty");
  assert(
    Number.isSafeInteger(requestedCount) &&
      requestedCount > 0 &&
      requestedCount <= contentIds.length,
    "doctor measurement interval count is invalid",
  );
  const intervals: DocumentInterval[] = [];
  for (let index = 0; index < requestedCount; index += 1) {
    const end = Math.floor(((index + 1) * contentIds.length) / requestedCount) - 1;
    const upperInclusive = contentIds[end];
    assert(upperInclusive !== undefined, "doctor measurement interval upper bound is absent");
    const lowerExclusive = index === 0 ? contentIds[0]! - 1 : intervals[index - 1]!.upperInclusive;
    intervals.push({ lowerExclusive, upperInclusive });
  }
  assertIntervals(contentIds, intervals);
  return intervals;
}

function createAdmissionIntervals(
  contentRows: readonly ContentRow[],
  rowTarget: number,
  byteTarget: number,
): readonly DocumentInterval[] {
  assert(contentRows.length > 0, "doctor measurement content rows are empty");
  assert(
    Number.isSafeInteger(rowTarget) &&
      rowTarget > 0 &&
      Number.isSafeInteger(byteTarget) &&
      byteTarget > 0,
    "doctor measurement admission targets are invalid",
  );
  const intervals: DocumentInterval[] = [];
  let lowerExclusive = contentRows[0]!.contentId - 1;
  let admittedRows = 0;
  let admittedBytes = 0;
  let lastContentId: number | undefined;

  const finishInterval = () => {
    assert(lastContentId !== undefined, "doctor measurement admission interval is empty");
    intervals.push({ lowerExclusive, upperInclusive: lastContentId });
    lowerExclusive = lastContentId;
    admittedRows = 0;
    admittedBytes = 0;
    lastContentId = undefined;
  };

  for (const row of contentRows) {
    assert(
      Number.isSafeInteger(row.bytes) && row.bytes >= 0,
      "doctor measurement content byte length is invalid",
    );
    if (admittedRows > 0 && (admittedRows >= rowTarget || admittedBytes + row.bytes > byteTarget)) {
      finishInterval();
    }
    admittedRows += 1;
    admittedBytes += row.bytes;
    lastContentId = row.contentId;
    if (row.bytes > byteTarget) {
      assert.equal(admittedRows, 1, "oversized doctor content was not admitted alone");
      finishInterval();
    }
  }
  if (admittedRows > 0) finishInterval();
  assertIntervals(
    contentRows.map(({ contentId }) => contentId),
    intervals,
  );
  return intervals;
}

function assertIntervals(
  contentIds: readonly number[],
  intervals: readonly DocumentInterval[],
): void {
  let previousUpper: number | undefined;
  for (const interval of intervals) {
    assert(
      Number.isSafeInteger(interval.lowerExclusive) &&
        Number.isSafeInteger(interval.upperInclusive) &&
        interval.lowerExclusive < interval.upperInclusive,
      "doctor measurement interval is malformed",
    );
    if (previousUpper !== undefined) {
      assert.equal(
        interval.lowerExclusive,
        previousUpper,
        "doctor measurement intervals are not contiguous",
      );
    }
    previousUpper = interval.upperInclusive;
  }
  for (const contentId of contentIds) {
    assert.equal(
      intervals.filter(
        (interval) => contentId > interval.lowerExclusive && contentId <= interval.upperInclusive,
      ).length,
      1,
      "doctor measurement content ID was not covered exactly once",
    );
  }
}

function coordinatesMatch(database: DatabaseSync, intervals: readonly DocumentInterval[]): boolean {
  const reference = database.prepare(
    `SELECT term, doc, col, offset
     FROM temp.${FTS_VOCAB_TABLE}
     ORDER BY doc, term COLLATE BINARY, col COLLATE BINARY, offset`,
  );
  reference.setReadBigInts(true);
  const referenceIterator = reference.iterate()[Symbol.iterator]() as Iterator<
    Record<string, unknown>
  >;
  try {
    for (const [index, interval] of intervals.entries()) {
      const query = prepareCoordinateInterval(database, index === 0);
      const parameters =
        index === 0
          ? ([interval.upperInclusive] as const)
          : ([interval.lowerExclusive, interval.upperInclusive] as const);
      for (const row of query.iterate(...parameters) as Iterable<Record<string, unknown>>) {
        const expected = referenceIterator.next();
        if (expected.done || !sameCoordinate(expected.value, row)) return false;
      }
    }
    return referenceIterator.next().done === true;
  } finally {
    referenceIterator.return?.();
  }
}

function prepareCoordinateInterval(database: DatabaseSync, prefix: boolean): StatementSync {
  const statement = database.prepare(
    `SELECT term, doc, col, offset
     FROM temp.${FTS_VOCAB_TABLE}
     WHERE ${prefix ? "doc <= ?" : "doc > ? AND doc <= ?"}
     ORDER BY doc, term COLLATE BINARY, col COLLATE BINARY, offset`,
  );
  statement.setReadBigInts(true);
  return statement;
}

function sameCoordinate(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return (
    left.term === right.term &&
    left.doc === right.doc &&
    left.col === right.col &&
    left.offset === right.offset
  );
}

interface TermSummary {
  readonly documents: bigint;
  readonly instances: bigint;
}

function readTermSummaries(database: DatabaseSync): ReadonlyMap<string, TermSummary> {
  const statement = database.prepare(
    `SELECT term, COUNT(DISTINCT doc) AS documents, COUNT(*) AS instances
     FROM temp.${FTS_VOCAB_TABLE}
     GROUP BY term
     ORDER BY term COLLATE BINARY`,
  );
  statement.setReadBigInts(true);
  const summaries = new Map<string, TermSummary>();
  for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
    const term = nonEmptyString(row.term);
    summaries.set(term, {
      documents: positiveSqliteInteger(row.documents),
      instances: positiveSqliteInteger(row.instances),
    });
  }
  return summaries;
}

function termSummariesMatch(
  database: DatabaseSync,
  intervals: readonly DocumentInterval[],
  reference: ReadonlyMap<string, TermSummary>,
): boolean {
  const actual = new Map<string, TermSummary>();
  for (const [index, interval] of intervals.entries()) {
    const statement = prepareTermSummaryInterval(database, index === 0);
    const parameters =
      index === 0
        ? ([interval.upperInclusive] as const)
        : ([interval.lowerExclusive, interval.upperInclusive] as const);
    for (const row of statement.iterate(...parameters) as Iterable<Record<string, unknown>>) {
      const term = nonEmptyString(row.term);
      const existing = actual.get(term);
      const documents = positiveSqliteInteger(row.documents);
      const instances = positiveSqliteInteger(row.instances);
      actual.set(term, {
        documents: (existing?.documents ?? 0n) + documents,
        instances: (existing?.instances ?? 0n) + instances,
      });
    }
  }
  if (actual.size !== reference.size) return false;
  for (const [term, expected] of reference) {
    const value = actual.get(term);
    if (
      value === undefined ||
      value.documents !== expected.documents ||
      value.instances !== expected.instances
    ) {
      return false;
    }
  }
  return true;
}

function prepareTermSummaryInterval(database: DatabaseSync, prefix: boolean): StatementSync {
  const statement = database.prepare(
    `SELECT term, COUNT(DISTINCT doc) AS documents, COUNT(*) AS instances
     FROM temp.${FTS_VOCAB_TABLE}
     WHERE ${prefix ? "doc <= ?" : "doc > ? AND doc <= ?"}
     GROUP BY term
     ORDER BY term COLLATE BINARY`,
  );
  statement.setReadBigInts(true);
  return statement;
}

function docsizeCoverageIsExact(
  database: DatabaseSync,
  contentIds: readonly number[],
  intervals: readonly DocumentInterval[],
): boolean {
  const statement = database.prepare("SELECT id FROM sessions_content_fts_docsize ORDER BY id");
  statement.setReadBigInts(true);
  const indexedIds = (statement.all() as readonly Record<string, unknown>[]).map((row) =>
    safeNumber(sqliteInteger(row.id)),
  );
  if (
    indexedIds.length !== contentIds.length ||
    indexedIds.some((contentId, index) => contentId !== contentIds[index])
  ) {
    return false;
  }
  return contentIds.every(
    (contentId) =>
      intervals.filter(
        (interval) => contentId > interval.lowerExclusive && contentId <= interval.upperInclusive,
      ).length === 1,
  );
}

function finalTailIsEmpty(database: DatabaseSync, intervals: readonly DocumentInterval[]): boolean {
  const upper = intervals.at(-1)?.upperInclusive;
  assert(upper !== undefined, "doctor measurement final interval is absent");
  return (
    database
      .prepare(`SELECT 1 AS unexpected FROM temp.${FTS_VOCAB_TABLE} WHERE doc > ? LIMIT 1`)
      .get(upper) === undefined
  );
}

function consumeInstanceQueries(
  database: DatabaseSync,
  intervals: readonly DocumentInterval[],
): number {
  let rows = 0;
  for (const [index, interval] of intervals.entries()) {
    const statement = database.prepare(
      `SELECT term, doc, col, offset
       FROM temp.${FTS_VOCAB_TABLE}
       WHERE ${index === 0 ? "doc <= ?" : "doc > ? AND doc <= ?"}`,
    );
    statement.setReadBigInts(true);
    const parameters =
      index === 0
        ? ([interval.upperInclusive] as const)
        : ([interval.lowerExclusive, interval.upperInclusive] as const);
    for (const row of statement.iterate(...parameters) as Iterable<Record<string, unknown>>) {
      validateCoordinate(row);
      rows += 1;
    }
  }
  const finalUpper = intervals.at(-1)!.upperInclusive;
  const tail = database.prepare(
    `SELECT term, doc, col, offset FROM temp.${FTS_VOCAB_TABLE} WHERE doc > ?`,
  );
  tail.setReadBigInts(true);
  for (const row of tail.iterate(finalUpper) as Iterable<Record<string, unknown>>) {
    validateCoordinate(row);
    rows += 1;
  }
  return rows;
}

function consumeTermSummaryQueries(
  database: DatabaseSync,
  intervals: readonly DocumentInterval[],
): number {
  let rows = 0;
  for (const [index, interval] of intervals.entries()) {
    const statement = prepareTermSummaryInterval(database, index === 0);
    const parameters =
      index === 0
        ? ([interval.upperInclusive] as const)
        : ([interval.lowerExclusive, interval.upperInclusive] as const);
    for (const row of statement.iterate(...parameters) as Iterable<Record<string, unknown>>) {
      validateTermSummary(row);
      rows += 1;
    }
  }
  const tail = database.prepare(
    `SELECT term, COUNT(DISTINCT doc) AS documents, COUNT(*) AS instances
     FROM temp.${FTS_VOCAB_TABLE}
     WHERE doc > ?
     GROUP BY term
     ORDER BY term COLLATE BINARY`,
  );
  tail.setReadBigInts(true);
  for (const row of tail.iterate(intervals.at(-1)!.upperInclusive) as Iterable<
    Record<string, unknown>
  >) {
    validateTermSummary(row);
    rows += 1;
  }
  return rows;
}

function validateCoordinate(row: Record<string, unknown>): void {
  nonEmptyString(row.term);
  positiveSqliteInteger(row.doc);
  nonEmptyString(row.col);
  const offset = sqliteInteger(row.offset);
  assert(offset >= 0n, "doctor measurement FTS offset is negative");
}

function validateTermSummary(row: Record<string, unknown>): void {
  nonEmptyString(row.term);
  positiveSqliteInteger(row.documents);
  positiveSqliteInteger(row.instances);
}

function readProbePlans(
  database: DatabaseSync,
  intervals: readonly DocumentInterval[],
): ProbePlanReport {
  const first = intervals[0]!;
  const last = intervals.at(-1)!;
  const middleLower = intervals.length > 1 ? intervals[1]!.lowerExclusive : first.lowerExclusive;
  const middleUpper = intervals.length > 1 ? intervals[1]!.upperInclusive : first.upperInclusive;
  return {
    rawInstances: planShape(
      database,
      "SELECT term, doc, col, offset FROM temp.sessions_measure_actual_vocab%s",
      {
        prefix: [first.upperInclusive],
        middle: [middleLower, middleUpper],
        tail: [last.upperInclusive],
      },
    ),
    termSummaries: planShape(
      database,
      `SELECT term, COUNT(DISTINCT doc) AS documents, COUNT(*) AS instances
       FROM temp.sessions_measure_actual_vocab%s
       GROUP BY term
       ORDER BY term COLLATE BINARY`,
      {
        prefix: [first.upperInclusive],
        middle: [middleLower, middleUpper],
        tail: [last.upperInclusive],
      },
    ),
  };
}

function planShape(
  database: DatabaseSync,
  template: string,
  parameters: {
    readonly prefix: readonly number[];
    readonly middle: readonly number[];
    readonly tail: readonly number[];
  },
): PlanShapeReport {
  const unboundedRows = explain(database, template.replace("%s", ""), []);
  const prefixRows = explain(
    database,
    template.replace("%s", " WHERE doc <= ?"),
    parameters.prefix,
  );
  const middleRows = explain(
    database,
    template.replace("%s", " WHERE doc > ? AND doc <= ?"),
    parameters.middle,
  );
  const tailRows = explain(database, template.replace("%s", " WHERE doc > ?"), parameters.tail);
  const unboundedSignature = planSignature(unboundedRows);
  return {
    unbounded: aggregatePlan(unboundedRows),
    prefix: aggregatePlan(prefixRows),
    middle: aggregatePlan(middleRows),
    tail: aggregatePlan(tailRows),
    prefixDiffersFromUnbounded: !sameStrings(unboundedSignature, planSignature(prefixRows)),
    middleDiffersFromUnbounded: !sameStrings(unboundedSignature, planSignature(middleRows)),
    tailDiffersFromUnbounded: !sameStrings(unboundedSignature, planSignature(tailRows)),
  };
}

function explain(
  database: DatabaseSync,
  sql: string,
  parameters: readonly number[],
): readonly Record<string, unknown>[] {
  return database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as readonly Record<
    string,
    unknown
  >[];
}

function planSignature(rows: readonly Record<string, unknown>[]): readonly string[] {
  return rows.map((row) =>
    nonEmptyString(row.detail).replaceAll(FTS_VOCAB_TABLE, "<vocab>").replace(/\s+/gu, " ").trim(),
  );
}

function aggregatePlan(rows: readonly Record<string, unknown>[]): PlanAggregate {
  const details = rows.map((row) => nonEmptyString(row.detail));
  return {
    rows: details.length,
    virtualTableScans: details.filter((detail) => /^(?:SCAN|SEARCH) .+ VIRTUAL TABLE/u.test(detail))
      .length,
    temporaryBtrees: details.filter((detail) => detail.includes("USE TEMP B-TREE")).length,
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function createActualVocab(database: DatabaseSync): void {
  database.exec(
    `CREATE VIRTUAL TABLE temp.${FTS_VOCAB_TABLE}
     USING fts5vocab(main, sessions_content_fts, 'instance')`,
  );
}

function dropActualVocab(database: DatabaseSync): void {
  database.exec(`DROP TABLE IF EXISTS temp.${FTS_VOCAB_TABLE}`);
}

function actualVocabIsAbsent(database: DatabaseSync): boolean {
  return (
    database
      .prepare("SELECT 1 FROM sqlite_temp_schema WHERE name = ? LIMIT 1")
      .get(FTS_VOCAB_TABLE) === undefined
  );
}

function configureMemoryTemp(database: DatabaseSync): void {
  database.exec("PRAGMA trusted_schema = OFF; PRAGMA temp_store = MEMORY");
  const row = database.prepare("PRAGMA temp_store").get() as Record<string, unknown> | undefined;
  assert.equal(row?.temp_store, 2, "doctor measurement TEMP storage is not memory-only");
}

function openImmutableDatabase(databasePath: string): DatabaseSync {
  const url = pathToFileURL(databasePath);
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");
  return new DatabaseSync(url.href, {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    readOnly: true,
    timeout: 5_000,
  });
}

function summarizeStrategy(
  strategy: StrategyName,
  samples: readonly MeasureWorkerReport[],
  equality: EqualityStrategyReport,
): StrategyMeasurementReport {
  assert(samples.length > 0, "doctor measurement strategy had no samples");
  const first = samples[0]!;
  assert.equal(
    first.intervalCount,
    equality.intervalCount,
    "doctor equality and measurement interval counts changed",
  );
  for (const sample of samples) {
    assert.equal(sample.strategy, strategy, "doctor measurement sample strategy changed");
    assert.equal(
      sample.intervalCount,
      first.intervalCount,
      "doctor measurement sample interval count changed",
    );
    assert.equal(
      sample.queriesPerShape,
      first.queriesPerShape,
      "doctor measurement sample query count changed",
    );
    assert.equal(
      sample.instanceRows,
      first.instanceRows,
      "doctor measurement sample instance count changed",
    );
    assert.equal(
      sample.termSummaryRows,
      first.termSummaryRows,
      "doctor measurement sample term summary count changed",
    );
  }
  return {
    name: strategy,
    intervalCount: first.intervalCount,
    bounds: summarizeIntervalBounds(equality.intervals),
    queriesPerShape: first.queriesPerShape,
    instanceRows: first.instanceRows,
    termSummaryRows: first.termSummaryRows,
    phases: {
      rawInstancesMs: numericAggregate(samples.map((sample) => sample.phases.rawInstancesMs)),
      termSummariesMs: numericAggregate(samples.map((sample) => sample.phases.termSummariesMs)),
      totalMs: numericAggregate(samples.map((sample) => sample.phases.totalMs)),
    },
    peakRssBytes: rssAggregate(samples.map((sample) => sample.peakRssBytes)),
  };
}

function summarizeIntervalBounds(
  intervals: readonly DocumentInterval[],
): StrategyMeasurementReport["bounds"] {
  assert(intervals.length > 0, "doctor measurement interval bounds are empty");
  const spans = intervals.map((interval) => interval.upperInclusive - interval.lowerExclusive);
  return {
    firstLowerExclusive: intervals[0]!.lowerExclusive,
    lastUpperInclusive: intervals.at(-1)!.upperInclusive,
    minimumIdSpan: Math.min(...spans),
    maximumIdSpan: Math.max(...spans),
  };
}

function numericAggregate(values: readonly number[]): NumericAggregate {
  assert(values.length > 0, "doctor measurement numeric aggregate is empty");
  assert(
    values.every((value) => Number.isFinite(value) && value >= 0),
    "doctor measurement elapsed sample is invalid",
  );
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: values,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
  };
}

function rssAggregate(values: readonly number[]): RssAggregate {
  assert(
    values.length > 0 && values.every((value) => Number.isSafeInteger(value) && value > 0),
    "doctor measurement RSS sample is invalid",
  );
  return { samples: values, max: Math.max(...values) };
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index]!;
}

function ratio(numerator: number, denominator: number): number {
  assert(
    Number.isFinite(numerator) && Number.isFinite(denominator) && numerator >= 0 && denominator > 0,
    "doctor measurement ratio inputs are invalid",
  );
  return Number((numerator / denominator).toFixed(3));
}

function rotateStrategies(round: number): readonly StrategyName[] {
  const offset = round % STRATEGIES.length;
  return [...STRATEGIES.slice(offset), ...STRATEGIES.slice(0, offset)];
}

function expectedIntervalCount(configuration: CohortConfiguration, strategy: StrategyName): number {
  if (strategy === "one") return 1;
  if (strategy === "two") return 2;
  return configuration.manyIntervals;
}

function cohortConfigurations(contract: boolean): readonly CohortConfiguration[] {
  if (contract) {
    return [
      {
        name: "small",
        uniqueValues: 32,
        manyIntervals: 4,
        rowIntervalTarget: 12,
        byteIntervalTarget: CONTRACT_SMALL_BYTE_TARGET,
        repeatedTermTarget: 8,
      },
      {
        name: "large",
        uniqueValues: 128,
        manyIntervals: 8,
        rowIntervalTarget: 20,
        byteIntervalTarget: CONTRACT_LARGE_BYTE_TARGET,
        repeatedTermTarget: 16,
      },
    ];
  }
  return [
    {
      name: "small",
      uniqueValues: 512,
      manyIntervals: 3,
      rowIntervalTarget: 512,
      byteIntervalTarget: PRODUCTION_BYTE_INTERVAL_TARGET,
      repeatedTermTarget: 64,
    },
    {
      name: "large",
      uniqueValues: 20_000,
      manyIntervals: 41,
      rowIntervalTarget: 512,
      byteIntervalTarget: PRODUCTION_BYTE_INTERVAL_TARGET,
      repeatedTermTarget: 1_000,
    },
  ];
}

function configurationFor(contract: boolean, name: string): CohortConfiguration {
  const configuration = cohortConfigurations(contract).find((candidate) => candidate.name === name);
  assert(configuration !== undefined, "doctor measurement cohort is invalid");
  return configuration;
}

function readSeedWorkerReport(value: unknown): SeedWorkerReport {
  const record = exactRecord(value, [
    "contentRows",
    "contentBytes",
    "entryRows",
    "instanceRows",
    "repeatedTermInstances",
    "oversizedContentRows",
    "zeroTokenContentRows",
  ]);
  return {
    contentRows: positiveNumber(record.contentRows),
    contentBytes: positiveNumber(record.contentBytes),
    entryRows: positiveNumber(record.entryRows),
    instanceRows: positiveNumber(record.instanceRows),
    repeatedTermInstances: positiveNumber(record.repeatedTermInstances),
    oversizedContentRows: positiveNumber(record.oversizedContentRows),
    zeroTokenContentRows: positiveNumber(record.zeroTokenContentRows),
  };
}

function readEqualityWorkerReport(value: unknown): EqualityWorkerReport {
  const record = exactRecord(value, ["contentRows", "instanceRows", "termCount", "strategies"]);
  assert(Array.isArray(record.strategies), "equality strategies are invalid");
  return {
    contentRows: positiveNumber(record.contentRows),
    instanceRows: positiveNumber(record.instanceRows),
    termCount: positiveNumber(record.termCount),
    strategies: record.strategies.map(readEqualityStrategyReport),
  };
}

function readEqualityStrategyReport(value: unknown): EqualityStrategyReport {
  const record = exactRecord(value, [
    "name",
    "intervalCount",
    "intervals",
    "coordinateEquality",
    "termSummaryEquality",
    "docsizeCoverage",
    "finalTailEmpty",
  ]);
  assert(Array.isArray(record.intervals), "equality intervals are invalid");
  const intervals = record.intervals.map((interval) => {
    const bounds = exactRecord(interval, ["lowerExclusive", "upperInclusive"]);
    return {
      lowerExclusive: integerNumber(bounds.lowerExclusive),
      upperInclusive: integerNumber(bounds.upperInclusive),
    };
  });
  return {
    name: requiredStrategy(record.name),
    intervalCount: positiveNumber(record.intervalCount),
    intervals,
    coordinateEquality: trueBoolean(record.coordinateEquality),
    termSummaryEquality: trueBoolean(record.termSummaryEquality),
    docsizeCoverage: trueBoolean(record.docsizeCoverage),
    finalTailEmpty: trueBoolean(record.finalTailEmpty),
  };
}

function readMeasureWorkerReport(value: unknown): MeasureWorkerReport {
  const record = exactRecord(value, [
    "strategy",
    "intervalCount",
    "queriesPerShape",
    "instanceRows",
    "termSummaryRows",
    "phases",
    "peakRssBytes",
    "memoryOnlyTemp",
    "tempCleanup",
    "plans",
  ]);
  const phases = exactRecord(record.phases, ["rawInstancesMs", "termSummariesMs", "totalMs"]);
  return {
    strategy: requiredStrategy(record.strategy),
    intervalCount: positiveNumber(record.intervalCount),
    queriesPerShape: positiveNumber(record.queriesPerShape),
    instanceRows: positiveNumber(record.instanceRows),
    termSummaryRows: positiveNumber(record.termSummaryRows),
    phases: {
      rawInstancesMs: nonNegativeFinite(phases.rawInstancesMs),
      termSummariesMs: nonNegativeFinite(phases.termSummariesMs),
      totalMs: nonNegativeFinite(phases.totalMs),
    },
    peakRssBytes: positiveNumber(record.peakRssBytes),
    memoryOnlyTemp: trueBoolean(record.memoryOnlyTemp),
    tempCleanup: trueBoolean(record.tempCleanup),
    plans: readProbePlanReport(record.plans),
  };
}

function readProbePlanReport(value: unknown): ProbePlanReport {
  const record = exactRecord(value, ["rawInstances", "termSummaries"]);
  return {
    rawInstances: readPlanShapeReport(record.rawInstances),
    termSummaries: readPlanShapeReport(record.termSummaries),
  };
}

function readPlanShapeReport(value: unknown): PlanShapeReport {
  const record = exactRecord(value, [
    "unbounded",
    "prefix",
    "middle",
    "tail",
    "prefixDiffersFromUnbounded",
    "middleDiffersFromUnbounded",
    "tailDiffersFromUnbounded",
  ]);
  return {
    unbounded: readPlanAggregate(record.unbounded),
    prefix: readPlanAggregate(record.prefix),
    middle: readPlanAggregate(record.middle),
    tail: readPlanAggregate(record.tail),
    prefixDiffersFromUnbounded: booleanValue(record.prefixDiffersFromUnbounded),
    middleDiffersFromUnbounded: booleanValue(record.middleDiffersFromUnbounded),
    tailDiffersFromUnbounded: booleanValue(record.tailDiffersFromUnbounded),
  };
}

function readPlanAggregate(value: unknown): PlanAggregate {
  const record = exactRecord(value, ["rows", "virtualTableScans", "temporaryBtrees"]);
  return {
    rows: positiveNumber(record.rows),
    virtualTableScans: nonNegativeInteger(record.virtualTableScans),
    temporaryBtrees: nonNegativeInteger(record.temporaryBtrees),
  };
}

function readHealthWorkerReport(value: unknown): HealthWorkerReport {
  const record = exactRecord(value, ["healthy"]);
  return { healthy: trueBoolean(record.healthy) };
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  assert(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "doctor measurement worker report is not an object",
  );
  const record = value as Record<string, unknown>;
  assert.deepStrictEqual(
    Object.keys(record).sort(),
    [...keys].sort(),
    "doctor measurement worker report fields changed",
  );
  return record;
}

function positiveNumber(value: unknown): number {
  assert(
    typeof value === "number" && Number.isSafeInteger(value) && value > 0,
    "doctor measurement positive number is invalid",
  );
  return value;
}

function integerNumber(value: unknown): number {
  assert(
    typeof value === "number" && Number.isSafeInteger(value),
    "doctor measurement integer is invalid",
  );
  return value;
}

function nonNegativeInteger(value: unknown): number {
  assert(
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    "doctor measurement non-negative integer is invalid",
  );
  return value;
}

function nonNegativeFinite(value: unknown): number {
  assert(
    typeof value === "number" && Number.isFinite(value) && value >= 0,
    "doctor measurement elapsed value is invalid",
  );
  return value;
}

function booleanValue(value: unknown): boolean {
  assert(typeof value === "boolean", "doctor measurement boolean is invalid");
  return value;
}

function trueBoolean(value: unknown): true {
  assert.equal(value, true, "doctor measurement correctness assertion failed");
  return true;
}

function requiredStrategy(value: unknown): StrategyName {
  assert(
    typeof value === "string" && STRATEGIES.includes(value as StrategyName),
    "doctor measurement strategy is invalid",
  );
  return value as StrategyName;
}

function nonEmptyString(value: unknown): string {
  assert(typeof value === "string" && value.length > 0, "doctor measurement text is invalid");
  return value;
}

function sqliteInteger(value: unknown): bigint {
  assert(typeof value === "bigint", "doctor measurement SQLite integer is invalid");
  return value;
}

function positiveSqliteInteger(value: unknown): bigint {
  const integer = sqliteInteger(value);
  assert(integer > 0n, "doctor measurement SQLite integer is not positive");
  return integer;
}

function safeNumber(value: bigint): number {
  const converted = Number(value);
  assert(Number.isSafeInteger(converted), "doctor measurement integer exceeds safe range");
  return converted;
}

function countRows(database: DatabaseSync, sql: string): number {
  const row = database.prepare(sql).get() as Record<string, unknown> | undefined;
  return integerNumber(row?.rows);
}

function roundMeasurement(value: number): number {
  return Number(value.toFixed(6));
}

function readOption(name: string): string | undefined {
  const indexes = process.argv.flatMap((value, index) => (value === name ? [index] : []));
  assert(indexes.length <= 1, `duplicate ${name} option`);
  const index = indexes[0];
  if (index === undefined) return undefined;
  const value = process.argv[index + 1];
  assert(value !== undefined && !value.startsWith("--"), `missing ${name} value`);
  return value;
}

function requiredOption(name: string): string {
  const value = readOption(name);
  assert(value !== undefined, `missing ${name} option`);
  return value;
}

function requiredWorkerMode(): WorkerMode {
  const mode = requiredOption("--worker");
  assert(
    mode === "seed" || mode === "equality" || mode === "measure" || mode === "health",
    "invalid doctor measurement worker mode",
  );
  return mode;
}

function assertControllerArguments(): void {
  const allowed = new Set([SCRIPT_PATH, "--", "--contract", "--force-child-failure"]);
  for (const value of process.argv.slice(1)) {
    assert(allowed.has(value), "unexpected doctor measurement argument");
  }
}

function assertWorkerArguments(mode: WorkerMode): void {
  assert(
    mode === "seed" || mode === "equality" || mode === "measure" || mode === "health",
    "invalid doctor measurement worker mode",
  );
  const valued = new Set([
    "--worker",
    "--directory",
    "--root",
    "--capability",
    "--cohort",
    "--strategy",
  ]);
  const flags = new Set(["--contract", "--fail-after-open"]);
  for (let index = 2; index < process.argv.length; index += 1) {
    const value = process.argv[index]!;
    if (flags.has(value)) continue;
    assert(valued.has(value), "unexpected doctor measurement worker argument");
    index += 1;
    assert(process.argv[index] !== undefined, "doctor measurement worker option value is absent");
  }
  assert(path.isAbsolute(requiredOption("--directory")), "worker directory must be absolute");
  assert(path.isAbsolute(requiredOption("--root")), "worker root must be absolute");
  if (mode !== "measure") {
    assert(readOption("--strategy") === undefined, "unexpected worker strategy");
    assert(!process.argv.includes("--fail-after-open"), "unexpected worker failpoint");
  }
}

function pathsAt(directory: string): IndexPaths {
  return resolveIndexPaths({
    platform: process.platform,
    env: { SESSIONS_DATA_DIR: directory },
    homeDirectory: directory,
  });
}

async function createOwnedDirectory(directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700, recursive: false });
  await chmod(directory, 0o700);
  assert(await hasMode(directory, 0o700), "measurement directory permissions are not private");
}

async function createMeasurementRoot(parent: string): Promise<OwnedRoot> {
  const rootPath = await mkdtemp(path.join(parent, "sessions-doctor-measure-"));
  try {
    await chmod(rootPath, 0o700);
    assert(await hasMode(rootPath, 0o700), "measurement root permissions are not private");
    return await captureOwnedRoot(rootPath);
  } catch (operationError) {
    let cleanupError: unknown;
    try {
      await removeOwnedRoot(await captureOwnedRoot(rootPath));
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError === undefined) throw operationError;
    throw new AggregateError(
      [operationError, cleanupError],
      "measurement root setup and cleanup both failed",
    );
  }
}

async function createWorkerAuthority(root: string, capability: string): Promise<void> {
  assert(/^[a-f0-9]{64}$/u.test(capability), "measurement capability is invalid");
  const marker = path.join(root, AUTHORITY_MARKER);
  await writeFile(marker, capability, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await chmod(marker, 0o600);
  assert(await hasMode(marker, 0o600), "measurement authority permissions are not private");
}

async function assertSeedDirectoryEmpty(directory: string): Promise<void> {
  assert.deepStrictEqual(
    await readdir(directory),
    [],
    "doctor measurement seed directory is not empty",
  );
}

async function assertWorkerAuthority(
  root: string,
  directory: string,
  capability: string,
): Promise<void> {
  assert(/^[a-f0-9]{64}$/u.test(capability), "worker capability is invalid");
  assert(path.basename(root).startsWith("sessions-doctor-measure-"), "worker root name is invalid");
  const [resolvedRoot, resolvedDirectory] = await Promise.all([
    realpath(root),
    realpath(directory),
  ]);
  const relative = path.relative(resolvedRoot, resolvedDirectory);
  assert(
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative),
    "worker directory is outside its owned root",
  );
  const [rootStats, directoryStats, markerStats, markerContent] = await Promise.all([
    lstat(root, { bigint: true }),
    lstat(directory, { bigint: true }),
    lstat(path.join(root, AUTHORITY_MARKER), { bigint: true }),
    readFile(path.join(root, AUTHORITY_MARKER), "utf8"),
  ]);
  assert(
    rootStats.isDirectory() &&
      !rootStats.isSymbolicLink() &&
      directoryStats.isDirectory() &&
      !directoryStats.isSymbolicLink() &&
      markerStats.isFile() &&
      !markerStats.isSymbolicLink() &&
      rootStats.dev === directoryStats.dev &&
      rootStats.dev === markerStats.dev,
    "worker authority ownership is invalid",
  );
  assert.equal(markerContent, capability, "worker capability does not match its authority");
  assert(await hasMode(root, 0o700), "worker root permissions are not private");
  assert(await hasMode(directory, 0o700), "worker directory permissions are not private");
  assert(
    await hasMode(path.join(root, AUTHORITY_MARKER), 0o600),
    "worker authority permissions are not private",
  );
}

async function captureOwnedRoot(root: string): Promise<OwnedRoot> {
  const stats = await lstat(root, { bigint: true });
  assert(
    stats.isDirectory() && !stats.isSymbolicLink(),
    "measurement root is not an owned directory",
  );
  return { path: root, device: stats.dev, inode: stats.ino };
}

async function removeOwnedRoot(root: OwnedRoot): Promise<void> {
  const stats = await lstat(root.path, { bigint: true });
  assert(
    stats.isDirectory() &&
      !stats.isSymbolicLink() &&
      stats.dev === root.device &&
      stats.ino === root.inode,
    "measurement root ownership changed before cleanup",
  );
  await rm(root.path, { force: true, recursive: true });
  try {
    await lstat(root.path);
    assert.fail("measurement root remained after cleanup");
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
}

async function snapshotFile(file: string): Promise<FileSnapshot> {
  const stats = await lstat(file, { bigint: true });
  assert(stats.isFile() && !stats.isSymbolicLink(), "measurement database is not an owned file");
  return {
    device: stats.dev,
    inode: stats.ino,
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
    links: stats.nlink,
    size: stats.size,
    modified: stats.mtimeNs,
    changed: stats.ctimeNs,
    digest: createHash("sha256")
      .update(await readFile(file))
      .digest("hex"),
  };
}

function sameFileSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.links === right.links &&
    left.size === right.size &&
    left.modified === right.modified &&
    left.changed === right.changed &&
    left.digest === right.digest
  );
}

async function assertNoSidecars(database: string): Promise<void> {
  assert(await sidecarsAreAbsent(database), "measurement database retained a sidecar");
}

async function sidecarsAreAbsent(database: string): Promise<boolean> {
  for (const suffix of SIDECAR_SUFFIXES) {
    try {
      await lstat(`${database}${suffix}`);
      return false;
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
  }
  return true;
}

async function hasMode(target: string, expected: number): Promise<boolean> {
  if (process.platform === "win32") return false;
  const stats = await lstat(target);
  return (stats.mode & 0o777) === expected;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
