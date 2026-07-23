import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

const WARMUP_ROTATIONS = 2;
const MEASURED_ROTATIONS = 15;
const MATERIAL_OVERHEAD_MILLISECONDS = 25;
const MATERIAL_OVERHEAD_RATIO = 2;

interface Scenario {
  readonly name: "bareNode" | "version" | "topHelp" | "commandHelp" | "uninitializedList";
  readonly arguments: readonly string[];
  readonly assertOutput: (stdout: string) => void;
}

const compiledEntry = resolve("dist/bin/sessions.js");
const compiled = await stat(compiledEntry).catch(() => undefined);
assert(compiled?.isFile(), "Build dist before measuring CLI startup");

const temporaryRoot = await mkdtemp(join(tmpdir(), "sessions-cli-startup-"));
await chmod(temporaryRoot, 0o700);
let report: MeasurementReport | undefined;
try {
  const generatedDataDirectory = join(temporaryRoot, "library");
  const scenarios: readonly Scenario[] = [
    {
      name: "bareNode",
      arguments: ["-e", ""],
      assertOutput: (stdout) => assert.equal(stdout, ""),
    },
    {
      name: "version",
      arguments: [compiledEntry, "--version"],
      assertOutput: (stdout) => assert.match(stdout, /^\d+\.\d+\.\d+\n$/u),
    },
    {
      name: "topHelp",
      arguments: [compiledEntry, "--help"],
      assertOutput: (stdout) => assert.match(stdout, /^Usage: sessions/u),
    },
    {
      name: "commandHelp",
      arguments: [compiledEntry, "list", "--help"],
      assertOutput: (stdout) => assert.match(stdout, /^Usage: sessions list/u),
    },
    {
      name: "uninitializedList",
      arguments: [compiledEntry, "list", "--limit", "1", "--format", "json"],
      assertOutput: assertUninitializedList,
    },
  ];
  const samples = new Map<Scenario["name"], number[]>(scenarios.map(({ name }) => [name, []]));

  for (let rotation = 0; rotation < WARMUP_ROTATIONS + MEASURED_ROTATIONS; rotation += 1) {
    const ordered = rotate(scenarios, rotation % scenarios.length);
    for (const scenario of ordered) {
      const elapsed = runScenario(scenario, generatedDataDirectory);
      if (rotation >= WARMUP_ROTATIONS) samples.get(scenario.name)?.push(elapsed);
    }
  }

  const measurements = Object.fromEntries(
    scenarios.map(({ name }) => {
      const values = samples.get(name);
      assert(values !== undefined && values.length === MEASURED_ROTATIONS);
      return [name, summarize(values)];
    }),
  ) as Record<Scenario["name"], Summary>;
  const bareMedian = measurements.bareNode.medianMilliseconds;
  const candidates = (["version", "topHelp", "commandHelp"] as const).map((name) => {
    const median = measurements[name].medianMilliseconds;
    return {
      name,
      overheadMilliseconds: roundMilliseconds(median - bareMedian),
      overheadRatio: roundRatio(median / bareMedian),
    };
  });
  const lazyCompositionCandidate = candidates.every(
    ({ overheadMilliseconds, overheadRatio }) =>
      overheadMilliseconds >= MATERIAL_OVERHEAD_MILLISECONDS &&
      overheadRatio >= MATERIAL_OVERHEAD_RATIO,
  );

  report = {
    rotations: MEASURED_ROTATIONS,
    measurements,
    startupCandidates: candidates,
    materialGate: {
      minimumOverheadMilliseconds: MATERIAL_OVERHEAD_MILLISECONDS,
      minimumOverheadRatio: MATERIAL_OVERHEAD_RATIO,
      lazyCompositionCandidate,
    },
  };
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
assert.equal(await stat(temporaryRoot).catch(() => undefined), undefined);
assert(report !== undefined, "CLI startup measurement did not produce a report");
process.stdout.write(`${JSON.stringify({ ...report, temporaryCleanup: true })}\n`);

function runScenario(scenario: Scenario, generatedDataDirectory: string): number {
  const startedAt = performance.now();
  const result = spawnSync(process.execPath, scenario.arguments, {
    encoding: "utf8",
    env: {
      ...process.env,
      SESSIONS_DATA_DIR: generatedDataDirectory,
    },
    maxBuffer: 4 * 1_024 * 1_024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const elapsed = performance.now() - startedAt;
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `${scenario.name} received a signal`);
  assert.equal(result.status, 0, `${scenario.name} failed: ${result.stderr}`);
  assert.equal(result.stderr, "", `${scenario.name} wrote stderr`);
  scenario.assertOutput(result.stdout);
  return elapsed;
}

function assertUninitializedList(stdout: string): void {
  const parsed = JSON.parse(stdout) as unknown;
  assert(
    typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      "sessions" in parsed &&
      Array.isArray(parsed.sessions) &&
      parsed.sessions.length === 0,
    "Uninitialized list output changed",
  );
}

function rotate<T>(values: readonly T[], offset: number): readonly T[] {
  return [...values.slice(offset), ...values.slice(0, offset)];
}

interface Summary {
  readonly minimumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly p95Milliseconds: number;
}

interface MeasurementReport {
  readonly rotations: number;
  readonly measurements: Record<Scenario["name"], Summary>;
  readonly startupCandidates: readonly {
    readonly name: "version" | "topHelp" | "commandHelp";
    readonly overheadMilliseconds: number;
    readonly overheadRatio: number;
  }[];
  readonly materialGate: {
    readonly minimumOverheadMilliseconds: number;
    readonly minimumOverheadRatio: number;
    readonly lazyCompositionCandidate: boolean;
  };
}

function summarize(values: readonly number[]): Summary {
  const sorted = values.toSorted((left, right) => left - right);
  return {
    minimumMilliseconds: roundMilliseconds(sorted[0] ?? 0),
    medianMilliseconds: roundMilliseconds(percentile(sorted, 0.5)),
    p95Milliseconds: roundMilliseconds(percentile(sorted, 0.95)),
  };
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}

function roundMilliseconds(value: number): number {
  return Number(value.toFixed(3));
}

function roundRatio(value: number): number {
  return Number(value.toFixed(2));
}
