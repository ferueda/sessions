import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

const SCRIPT = path.resolve(import.meta.dirname, "../scripts/measure-doctor.ts");
const FAILURE_MESSAGE = "Doctor feasibility measurement failed\n";
const PRIVATE_CANARY = "doctor-measurement-private-canary";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe.skipIf(process.platform === "win32")("doctor feasibility measurement", () => {
  test("uses generated exact evidence and leaves no persistent or private output", async () => {
    const sandbox = await createSandbox();
    const temporaryParent = path.join(sandbox, "temporary");
    await mkdir(temporaryParent, { mode: 0o700 });
    await chmod(temporaryParent, 0o700);
    const result = runMeasurement(sandbox, temporaryParent, ["--contract"]);

    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(result.stdout).not.toContain(PRIVATE_CANARY);
    expect(result.stdout).not.toContain("memory://");
    expect(result.stdout).not.toContain("sessions-doctor-measure-");
    expect(result.stdout).not.toContain(sandbox);

    const report = readReport(JSON.parse(result.stdout));
    expect(report).toMatchObject({
      schemaVersion: 1,
      command: "measure-doctor",
      mode: "contract",
      acceptance: "accepted-rejection",
      configuration: {
        timingRounds: 2,
        intervalStrategies: ["one", "two", "many"],
        peakRssUnit: "bytes",
        generatedOnly: true,
        productionDoctorUnchanged: true,
      },
      temporaryCleanup: true,
    });
    expect(report.cohorts.map((cohort) => cohort.name)).toEqual(["small", "large"]);
    expect(report.cohorts.map((cohort) => cohort.corpus.rowIntervalTarget)).toEqual([12, 20]);
    expect(report.cohorts.map((cohort) => cohort.strategies[2]?.intervalCount)).toEqual([4, 8]);
    for (const cohort of report.cohorts) assertHealthyCohort(cohort, report.configuration);
    await expect(readdir(temporaryParent)).resolves.toEqual([]);
  }, 60_000);

  test("sanitizes a measured-child failure and removes every owned temporary file", async () => {
    const sandbox = await createSandbox();
    const temporaryParent = path.join(sandbox, "temporary");
    await mkdir(temporaryParent, { mode: 0o700 });
    await chmod(temporaryParent, 0o700);
    const result = runMeasurement(sandbox, temporaryParent, [
      "--contract",
      "--force-child-failure",
    ]);

    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(FAILURE_MESSAGE);
    expect(result.stderr).not.toContain(PRIVATE_CANARY);
    expect(result.stderr).not.toContain("sessions-doctor-measure-");
    expect(result.stderr).not.toContain(sandbox);
    await expect(readdir(temporaryParent)).resolves.toEqual([]);
  }, 60_000);

  test("rejects a direct seed worker without authority and preserves an existing library", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sessions-doctor-measure-"));
    temporaryDirectories.push(root);
    await chmod(root, 0o700);
    const library = path.join(root, "sentinel-library");
    await mkdir(library, { mode: 0o700 });
    await chmod(library, 0o700);
    const database = path.join(library, "sessions.sqlite3");
    const sentinel = Buffer.from("existing-sessions-library");
    await writeFile(database, sentinel, { mode: 0o600 });
    const entriesBefore = await readdir(library);

    const result = runDirectWorker(root, library);

    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    await expect(readdir(library)).resolves.toEqual(entriesBefore);
    await expect(readFile(database)).resolves.toEqual(sentinel);
  });
});

async function createSandbox(): Promise<string> {
  const sandbox = await mkdtemp(path.join(tmpdir(), "sessions-doctor-measurement-test-"));
  temporaryDirectories.push(sandbox);
  await chmod(sandbox, 0o700);
  return sandbox;
}

function runMeasurement(sandbox: string, temporaryParent: string, arguments_: readonly string[]) {
  const isolatedHome = path.join(sandbox, "home");
  return spawnSync(process.execPath, [SCRIPT, ...arguments_], {
    cwd: sandbox,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      CODEX_HOME: path.join(sandbox, "unavailable-codex"),
      CODEX_SQLITE_HOME: undefined,
      SESSIONS_DATA_DIR: undefined,
      SESSIONS_MEASURE_DOCTOR_TEMP_PARENT: temporaryParent,
    },
  });
}

function runDirectWorker(root: string, library: string) {
  return spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--worker",
      "seed",
      "--directory",
      library,
      "--root",
      root,
      "--cohort",
      "small",
      "--contract",
    ],
    {
      cwd: library,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        HOME: path.join(root, "home"),
        USERPROFILE: path.join(root, "home"),
        CODEX_HOME: path.join(root, "unavailable-codex"),
        CODEX_SQLITE_HOME: undefined,
        SESSIONS_DATA_DIR: undefined,
        SESSIONS_MEASURE_DOCTOR_TEMP_PARENT: undefined,
      },
    },
  );
}

interface MeasurementReport {
  readonly schemaVersion: number;
  readonly command: string;
  readonly mode: string;
  readonly acceptance: string;
  readonly configuration: {
    readonly timingRounds: number;
    readonly intervalStrategies: readonly string[];
    readonly peakRssUnit: string;
    readonly generatedOnly: boolean;
    readonly productionDoctorUnchanged: boolean;
  };
  readonly cohorts: readonly CohortReport[];
  readonly temporaryCleanup: boolean;
}

interface CohortReport {
  readonly name: string;
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
  readonly plans: ProbePlans;
  readonly strategies: readonly StrategyReport[];
  readonly scaling: {
    readonly twoToOneTotalRatio: number;
    readonly manyToOneTotalRatio: number;
    readonly manyToOneRawInstancesRatio: number;
    readonly manyToOneTermSummariesRatio: number;
    readonly manyToOnePeakRssRatio: number;
  };
}

interface ProbePlans {
  readonly rawInstances: PlanShape;
  readonly termSummaries: PlanShape;
}

interface PlanShape {
  readonly unbounded: PlanAggregate;
  readonly prefix: PlanAggregate;
  readonly middle: PlanAggregate;
  readonly tail: PlanAggregate;
  readonly prefixDiffersFromUnbounded: boolean;
  readonly middleDiffersFromUnbounded: boolean;
  readonly tailDiffersFromUnbounded: boolean;
}

interface PlanAggregate {
  readonly rows: number;
  readonly virtualTableScans: number;
  readonly temporaryBtrees: number;
}

interface StrategyReport {
  readonly name: string;
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
  readonly peakRssBytes: {
    readonly samples: readonly number[];
    readonly max: number;
  };
}

interface NumericAggregate {
  readonly samples: readonly number[];
  readonly median: number;
  readonly p95: number;
}

function readReport(value: unknown): MeasurementReport {
  const report = exactRecord(value, [
    "schemaVersion",
    "command",
    "mode",
    "acceptance",
    "configuration",
    "cohorts",
    "temporaryCleanup",
  ]);
  const configuration = exactRecord(report.configuration, [
    "timingRounds",
    "intervalStrategies",
    "peakRssUnit",
    "generatedOnly",
    "productionDoctorUnchanged",
  ]);
  expect(Array.isArray(report.cohorts)).toBe(true);
  expect(Array.isArray(configuration.intervalStrategies)).toBe(true);
  return {
    schemaVersion: numberValue(report.schemaVersion),
    command: stringValue(report.command),
    mode: stringValue(report.mode),
    acceptance: stringValue(report.acceptance),
    configuration: {
      timingRounds: numberValue(configuration.timingRounds),
      intervalStrategies: (configuration.intervalStrategies as unknown[]).map(stringValue),
      peakRssUnit: stringValue(configuration.peakRssUnit),
      generatedOnly: booleanValue(configuration.generatedOnly),
      productionDoctorUnchanged: booleanValue(configuration.productionDoctorUnchanged),
    },
    cohorts: (report.cohorts as unknown[]).map(readCohort),
    temporaryCleanup: booleanValue(report.temporaryCleanup),
  };
}

function readCohort(value: unknown): CohortReport {
  const cohort = exactRecord(value, [
    "name",
    "corpus",
    "cloneEquality",
    "exactQueryEquality",
    "intervalAccounting",
    "finalHealth",
    "persistentFileStateEqual",
    "sidecarsAbsentBeforeAndAfter",
    "ownedPermissions",
    "plans",
    "strategies",
    "scaling",
  ]);
  const corpus = exactRecord(cohort.corpus, [
    "sessions",
    "entries",
    "contentRows",
    "contentBytes",
    "instanceRows",
    "repeatedTermTarget",
    "repeatedTermInstances",
    "rowIntervalTarget",
    "byteIntervalTarget",
    "oversizedContentRows",
    "zeroTokenContentRows",
    "databaseBytes",
  ]);
  const scaling = exactRecord(cohort.scaling, [
    "twoToOneTotalRatio",
    "manyToOneTotalRatio",
    "manyToOneRawInstancesRatio",
    "manyToOneTermSummariesRatio",
    "manyToOnePeakRssRatio",
  ]);
  expect(Array.isArray(cohort.strategies)).toBe(true);
  return {
    name: stringValue(cohort.name),
    corpus: mapNumbers(corpus) as CohortReport["corpus"],
    cloneEquality: booleanValue(cohort.cloneEquality),
    exactQueryEquality: booleanValue(cohort.exactQueryEquality),
    intervalAccounting: booleanValue(cohort.intervalAccounting),
    finalHealth: booleanValue(cohort.finalHealth),
    persistentFileStateEqual: booleanValue(cohort.persistentFileStateEqual),
    sidecarsAbsentBeforeAndAfter: booleanValue(cohort.sidecarsAbsentBeforeAndAfter),
    ownedPermissions: booleanValue(cohort.ownedPermissions),
    plans: readPlans(cohort.plans),
    strategies: (cohort.strategies as unknown[]).map(readStrategy),
    scaling: mapNumbers(scaling) as CohortReport["scaling"],
  };
}

function readPlans(value: unknown): ProbePlans {
  const plans = exactRecord(value, ["rawInstances", "termSummaries"]);
  return {
    rawInstances: readPlanShape(plans.rawInstances),
    termSummaries: readPlanShape(plans.termSummaries),
  };
}

function readPlanShape(value: unknown): PlanShape {
  const shape = exactRecord(value, [
    "unbounded",
    "prefix",
    "middle",
    "tail",
    "prefixDiffersFromUnbounded",
    "middleDiffersFromUnbounded",
    "tailDiffersFromUnbounded",
  ]);
  return {
    unbounded: readPlanAggregate(shape.unbounded),
    prefix: readPlanAggregate(shape.prefix),
    middle: readPlanAggregate(shape.middle),
    tail: readPlanAggregate(shape.tail),
    prefixDiffersFromUnbounded: booleanValue(shape.prefixDiffersFromUnbounded),
    middleDiffersFromUnbounded: booleanValue(shape.middleDiffersFromUnbounded),
    tailDiffersFromUnbounded: booleanValue(shape.tailDiffersFromUnbounded),
  };
}

function readPlanAggregate(value: unknown): PlanAggregate {
  return mapNumbers(
    exactRecord(value, ["rows", "virtualTableScans", "temporaryBtrees"]),
  ) as unknown as PlanAggregate;
}

function readStrategy(value: unknown): StrategyReport {
  const strategy = exactRecord(value, [
    "name",
    "intervalCount",
    "bounds",
    "queriesPerShape",
    "instanceRows",
    "termSummaryRows",
    "phases",
    "peakRssBytes",
  ]);
  const bounds = exactRecord(strategy.bounds, [
    "firstLowerExclusive",
    "lastUpperInclusive",
    "minimumIdSpan",
    "maximumIdSpan",
  ]);
  const phases = exactRecord(strategy.phases, ["rawInstancesMs", "termSummariesMs", "totalMs"]);
  const rss = exactRecord(strategy.peakRssBytes, ["samples", "max"]);
  expect(Array.isArray(rss.samples)).toBe(true);
  return {
    name: stringValue(strategy.name),
    intervalCount: numberValue(strategy.intervalCount),
    bounds: mapNumbers(bounds) as StrategyReport["bounds"],
    queriesPerShape: numberValue(strategy.queriesPerShape),
    instanceRows: numberValue(strategy.instanceRows),
    termSummaryRows: numberValue(strategy.termSummaryRows),
    phases: {
      rawInstancesMs: readNumericAggregate(phases.rawInstancesMs),
      termSummariesMs: readNumericAggregate(phases.termSummariesMs),
      totalMs: readNumericAggregate(phases.totalMs),
    },
    peakRssBytes: {
      samples: (rss.samples as unknown[]).map(numberValue),
      max: numberValue(rss.max),
    },
  };
}

function readNumericAggregate(value: unknown): NumericAggregate {
  const aggregate = exactRecord(value, ["samples", "median", "p95"]);
  expect(Array.isArray(aggregate.samples)).toBe(true);
  return {
    samples: (aggregate.samples as unknown[]).map(numberValue),
    median: numberValue(aggregate.median),
    p95: numberValue(aggregate.p95),
  };
}

function assertHealthyCohort(
  cohort: CohortReport,
  configuration: MeasurementReport["configuration"],
): void {
  for (const count of Object.values(cohort.corpus)) expectPositiveSafeInteger(count);
  expect(cohort.corpus.sessions).toBe(1);
  expect(cohort.corpus.entries).toBeGreaterThan(0);
  expect(cohort.corpus.contentRows).toBeGreaterThan(0);
  expect(cohort.corpus.contentBytes).toBeGreaterThan(cohort.corpus.byteIntervalTarget);
  expect(cohort.corpus.repeatedTermInstances).toBeGreaterThan(cohort.corpus.repeatedTermTarget);
  expect(cohort.corpus.oversizedContentRows).toBe(1);
  expect(cohort.corpus.zeroTokenContentRows).toBeGreaterThanOrEqual(2);
  expect(cohort.cloneEquality).toBe(true);
  expect(cohort.exactQueryEquality).toBe(true);
  expect(cohort.intervalAccounting).toBe(true);
  expect(cohort.finalHealth).toBe(true);
  expect(cohort.persistentFileStateEqual).toBe(true);
  expect(cohort.sidecarsAbsentBeforeAndAfter).toBe(true);
  expect(cohort.ownedPermissions).toBe(true);
  expect(cohort.strategies.map((strategy) => strategy.name)).toEqual(["one", "two", "many"]);
  for (const strategy of cohort.strategies) {
    for (const count of [
      strategy.intervalCount,
      strategy.queriesPerShape,
      strategy.instanceRows,
      strategy.termSummaryRows,
    ]) {
      expectPositiveSafeInteger(count);
    }
    for (const bound of Object.values(strategy.bounds)) {
      expect(Number.isSafeInteger(bound)).toBe(true);
    }
    expect(strategy.bounds.firstLowerExclusive).toBeLessThan(strategy.bounds.lastUpperInclusive);
    expect(strategy.bounds.minimumIdSpan).toBeGreaterThan(0);
    expect(strategy.bounds.maximumIdSpan).toBeGreaterThanOrEqual(strategy.bounds.minimumIdSpan);
    expect(strategy.queriesPerShape).toBe(strategy.intervalCount + 1);
    expect(strategy.instanceRows).toBe(cohort.corpus.instanceRows);
    expect(strategy.phases.rawInstancesMs.samples).toHaveLength(configuration.timingRounds);
    expect(strategy.phases.termSummariesMs.samples).toHaveLength(configuration.timingRounds);
    expect(strategy.phases.totalMs.samples).toHaveLength(configuration.timingRounds);
    expect(strategy.peakRssBytes.samples).toHaveLength(configuration.timingRounds);
    expect(strategy.peakRssBytes.max).toBeGreaterThan(0);
    for (const sample of strategy.peakRssBytes.samples) expectPositiveSafeInteger(sample);
    for (const sample of [
      ...strategy.phases.rawInstancesMs.samples,
      ...strategy.phases.termSummariesMs.samples,
      ...strategy.phases.totalMs.samples,
    ]) {
      expect(Number.isFinite(sample)).toBe(true);
      expect(sample).toBeGreaterThanOrEqual(0);
    }
    assertNumericAggregate(strategy.phases.rawInstancesMs);
    assertNumericAggregate(strategy.phases.termSummariesMs);
    assertNumericAggregate(strategy.phases.totalMs);
    expect(strategy.peakRssBytes.max).toBe(Math.max(...strategy.peakRssBytes.samples));
  }
  const [one, two, many] = cohort.strategies;
  expect(one).toBeDefined();
  expect(two).toBeDefined();
  expect(many).toBeDefined();
  expect(many!.bounds.maximumIdSpan).toBeLessThanOrEqual(cohort.corpus.rowIntervalTarget);
  for (const shape of [cohort.plans.rawInstances, cohort.plans.termSummaries]) {
    for (const aggregate of [shape.unbounded, shape.prefix, shape.middle, shape.tail]) {
      expectPositiveSafeInteger(aggregate.rows);
      expectNonNegativeSafeInteger(aggregate.virtualTableScans);
      expectNonNegativeSafeInteger(aggregate.temporaryBtrees);
    }
  }
  expect(cohort.scaling).toEqual({
    twoToOneTotalRatio: roundedRatio(two!.phases.totalMs.median, one!.phases.totalMs.median),
    manyToOneTotalRatio: roundedRatio(many!.phases.totalMs.median, one!.phases.totalMs.median),
    manyToOneRawInstancesRatio: roundedRatio(
      many!.phases.rawInstancesMs.median,
      one!.phases.rawInstancesMs.median,
    ),
    manyToOneTermSummariesRatio: roundedRatio(
      many!.phases.termSummariesMs.median,
      one!.phases.termSummariesMs.median,
    ),
    manyToOnePeakRssRatio: roundedRatio(many!.peakRssBytes.max, one!.peakRssBytes.max),
  });
}

function assertNumericAggregate(aggregate: NumericAggregate): void {
  const sorted = [...aggregate.samples].sort((left, right) => left - right);
  expect(aggregate.median).toBe(percentile(sorted, 0.5));
  expect(aggregate.p95).toBe(percentile(sorted, 0.95));
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

function roundedRatio(numerator: number, denominator: number): number {
  return Number((numerator / denominator).toFixed(3));
}

function expectPositiveSafeInteger(value: number): void {
  expect(Number.isSafeInteger(value)).toBe(true);
  expect(value).toBeGreaterThan(0);
}

function expectNonNegativeSafeInteger(value: number): void {
  expect(Number.isSafeInteger(value)).toBe(true);
  expect(value).toBeGreaterThanOrEqual(0);
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  expect(typeof value).toBe("object");
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  const record = value as Record<string, unknown>;
  expect(Object.keys(record).sort()).toEqual([...keys].sort());
  return record;
}

function mapNumbers(record: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, numberValue(value)]),
  );
}

function numberValue(value: unknown): number {
  expect(typeof value).toBe("number");
  expect(Number.isFinite(value as number)).toBe(true);
  return value as number;
}

function stringValue(value: unknown): string {
  expect(typeof value).toBe("string");
  return value as string;
}

function booleanValue(value: unknown): boolean {
  expect(typeof value).toBe("boolean");
  return value as boolean;
}
