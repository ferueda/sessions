import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, test } from "vitest";

const EXPECTED_CASES = [
  "entries-broad",
  "entries-narrow",
  "list-activity",
  "list-identity",
  "manifest",
  "search-broad-all",
  "search-broad-any",
  "search-selective-all",
  "search-selective-any",
] as const;

describe("query planner statistics measurement", () => {
  test("isolates statistics mutations and proves semantic equality and cleanup", () => {
    const script = path.resolve(
      import.meta.dirname,
      "../scripts/measure-query-planner-statistics.ts",
    );
    const result = spawnSync(process.execPath, [script, "--contract"], {
      encoding: "utf8",
      timeout: 30_000,
    });

    if (result.status !== 0) throw new Error(result.stderr);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as MeasurementReport;
    expect(report).toMatchObject({
      schemaVersion: 1,
      mode: "contract",
      clonesVerifiedExact: true,
      semanticEquality: true,
      temporaryCleanup: true,
      variants: {
        control: {
          statisticsCommand: "none",
          databaseByteGrowth: 0,
          statistics: { tables: [] },
        },
        analyze: {
          statisticsCommand: "ANALYZE",
        },
        optimize: {
          statisticsCommand: "PRAGMA optimize = 0x10002",
        },
      },
    });
    expect(Object.keys(report.cases).sort()).toEqual(EXPECTED_CASES);
    expect(report.variants.analyze.statistics.tables.length).toBeGreaterThan(0);
    expect(report.variants.optimize.statistics.tables.length).toBeGreaterThan(0);
    for (const measurement of Object.values(report.cases)) {
      expect(measurement.semanticEqual).toBe(true);
      expect(measurement.plans.control.length).toBeGreaterThan(0);
      expect(measurement.elapsedMs.control.samples).toHaveLength(report.timingRounds);
      expect(measurement.elapsedMs.analyze.samples).toHaveLength(report.timingRounds);
      expect(measurement.elapsedMs.optimize.samples).toHaveLength(report.timingRounds);
    }
    expect(result.stdout).not.toContain("sessions-query-planner-statistics-");
    expect(result.stdout).not.toContain("memory://");
  });
});

interface MeasurementReport {
  readonly schemaVersion: number;
  readonly mode: string;
  readonly clonesVerifiedExact: boolean;
  readonly semanticEquality: boolean;
  readonly temporaryCleanup: boolean;
  readonly timingRounds: number;
  readonly variants: Record<
    "control" | "analyze" | "optimize",
    {
      readonly statisticsCommand: string;
      readonly databaseByteGrowth: number;
      readonly statistics: {
        readonly tables: readonly unknown[];
      };
    }
  >;
  readonly cases: Record<
    string,
    {
      readonly semanticEqual: boolean;
      readonly elapsedMs: Record<
        "control" | "analyze" | "optimize",
        { readonly samples: readonly number[] }
      >;
      readonly plans: Record<"control" | "analyze" | "optimize", readonly string[]>;
    }
  >;
}
