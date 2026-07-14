import { describe, expect, test } from "vitest";

import { createIndexReport, createIndexSourceReport } from "../../src/application/index-report.ts";
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
      counts: counts({ removed: 2 }),
      items: [{ identity: { source: second, nativeId: "removed" }, outcome: "removed" }],
      omittedItemCount: 1,
      failure: "discovery-failed",
    };

    const report = createIndexReport("start", "finish", [
      createIndexSourceReport(first, firstResult),
      createIndexSourceReport(second, secondResult),
    ]);

    expect(report.counts).toEqual(counts({ discovered: 101, failed: 101, removed: 2 }));
    expect(report.incompleteSources).toBe(1);
    expect(report.omittedItemCount).toBe(101);
    expect(report.sources[0]?.items).toEqual(firstResult.items);
    expect(report.sources[1]?.items).toEqual(secondResult.items);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.sources)).toBe(true);
    expect(Object.isFrozen(report.sources[0]?.items)).toBe(true);
  });
});

function counts(overrides: Partial<IndexRunResult["counts"]> = {}): IndexRunResult["counts"] {
  return {
    discovered: 0,
    unchanged: 0,
    updated: 0,
    failed: 0,
    removed: 0,
    stale: 0,
    ...overrides,
  };
}
