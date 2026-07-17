import { describe, expect, test } from "vitest";

import {
  createIndexReport,
  createIndexSourceReport,
  createSkippedIndexSourceReport,
} from "../../src/application/index-report.ts";
import type { IndexRunResult } from "../../src/application/ports/session-index.ts";

describe("index reports", () => {
  test("copies durable diagnostics and aggregates omitted items across sources", () => {
    const first = { kind: "alpha-source", instanceId: "one" } as const;
    const second = { kind: "beta-source", instanceId: "two" } as const;
    const firstResult: IndexRunResult = {
      source: first,
      status: "completed",
      startedAt: "2026-07-13T12:00:00.000Z",
      finishedAt: "2026-07-13T12:01:00.000Z",
      counts: counts({ discovered: 101, failed: 101 }),
      coverage: { status: "complete", observedAt: "2026-07-13T12:00:00.000Z" },
      items: [
        {
          identity: { source: first, nativeId: "failed" },
          outcome: "failed",
          failure: "malformed",
        },
      ],
      omittedItemCount: 100,
    };
    const secondResult: IndexRunResult = {
      source: second,
      status: "incomplete",
      startedAt: "2026-07-13T12:02:00.000Z",
      finishedAt: "2026-07-13T12:03:00.000Z",
      counts: counts({ missing: 2 }),
      coverage: { status: "unknown", observedAt: "2026-07-13T12:02:00.000Z" },
      items: [{ identity: { source: second, nativeId: "missing" }, outcome: "missing" }],
      omittedItemCount: 1,
      failure: "discovery-failed",
    };

    const report = createIndexReport("start", "finish", [
      createIndexSourceReport(first, firstResult),
      createIndexSourceReport(second, secondResult),
    ]);

    expect(report.counts).toEqual(counts({ discovered: 101, failed: 101, missing: 2 }));
    expect(report.incompleteSources).toBe(1);
    expect(report.skippedSources).toBe(0);
    expect(report.omittedItemCount).toBe(101);
    expect(report.sources[0]?.items[0]).toMatchObject(firstResult.items[0]!);
    expect(report.sources[0]?.items[0]?.identity).toHaveProperty("canonicalId");
    expect(report.sources[1]?.items[0]).toMatchObject(secondResult.items[0]!);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.sources)).toBe(true);
    expect(Object.isFrozen(report.sources[0]?.items)).toBe(true);
  });

  test("keeps unavailable skipped sources outside incomplete counts", () => {
    const source = { kind: "optional-source", instanceId: "one" } as const;

    const report = createIndexReport("start", "finish", [
      createSkippedIndexSourceReport(source, "source-start", "source-finish"),
    ]);

    expect(report).toEqual({
      schemaVersion: 1,
      command: "index",
      startedAt: "start",
      finishedAt: "finish",
      counts: counts(),
      sources: [
        {
          schemaVersion: 1,
          source,
          status: "skipped",
          reason: "source-unavailable",
          startedAt: "source-start",
          finishedAt: "source-finish",
          counts: counts(),
          coverage: { status: "not-attempted" },
          items: [],
          omittedItemCount: 0,
        },
      ],
      incompleteSources: 0,
      skippedSources: 1,
      omittedItemCount: 0,
    });
    expect(Object.isFrozen(report.sources[0])).toBe(true);
    expect(Object.isFrozen(report.sources[0]?.coverage)).toBe(true);
  });
});

function counts(overrides: Partial<IndexRunResult["counts"]> = {}): IndexRunResult["counts"] {
  return {
    discovered: 0,
    unchanged: 0,
    updated: 0,
    failed: 0,
    missing: 0,
    stale: 0,
    ...overrides,
  };
}
