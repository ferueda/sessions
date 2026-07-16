import { describe, expect, test } from "vitest";

import { INDEX_TIMING_PHASES, type IndexTimingPhase } from "../../src/application/index-timing.ts";
import {
  createIndexTimingCollector,
  encodeIndexTimingDiagnostic,
  type IndexTimingSnapshot,
} from "../../src/infrastructure/runtime/index-timings.ts";

describe("index timing collector", () => {
  test("aggregates only allowlisted phases and rounds the summed duration", () => {
    const collector = createIndexTimingCollector({ now: () => 42 });
    collector.recorder.record("writerOpen", 1.234_56);
    collector.recorder.record("writerOpen", 1.000_06);
    collector.recorder.record("sourceDiscovery", 0);

    const unsafeRecord = collector.recorder.record as (phase: string, elapsedMs: number) => void;
    unsafeRecord("private-phase", 99);
    unsafeRecord("writerOpen", -1);
    unsafeRecord("writerOpen", Number.NaN);
    unsafeRecord("writerOpen", Number.POSITIVE_INFINITY);

    const snapshot = collector.snapshot();

    expect(Object.keys(snapshot.phases)).toEqual(INDEX_TIMING_PHASES);
    expect(snapshot.phases.writerOpen).toEqual({ calls: 2, elapsedMs: 2.235 });
    expect(snapshot.phases.sourceDiscovery).toEqual({ calls: 1, elapsedMs: 0 });
    expect(snapshot.phases.total).toEqual({ calls: 0, elapsedMs: 0 });
    expect(snapshot.phases).not.toHaveProperty("private-phase");
  });

  test("encodes one fixed, sanitized diagnostic line", () => {
    const phases = Object.fromEntries(
      INDEX_TIMING_PHASES.map((phase) => [phase, { calls: 0, elapsedMs: 0 }]),
    ) as Record<IndexTimingPhase, { calls: number; elapsedMs: number }> & {
      privatePhase?: { calls: number; elapsedMs: number; privatePath: string };
    };
    phases.writerOpen = { calls: 1.5, elapsedMs: Number.POSITIVE_INFINITY };
    phases.total = { calls: 3, elapsedMs: 12.345_67 };
    phases.privatePhase = {
      calls: 1,
      elapsedMs: 99,
      privatePath: "/private/transcript.jsonl",
    };
    const snapshot = { diagnostic: "index-timings", phases } as IndexTimingSnapshot;

    const encoded = encodeIndexTimingDiagnostic(snapshot);

    expect(encoded.endsWith("\n")).toBe(true);
    expect(encoded).not.toContain("privatePhase");
    expect(encoded).not.toContain("private/transcript");
    const prefix = "sessions:index-timings ";
    expect(encoded.startsWith(prefix)).toBe(true);
    const diagnostic = JSON.parse(encoded.slice(prefix.length)) as {
      diagnostic: string;
      phases: Record<string, { calls: number; elapsedMs: number }>;
    };
    expect(diagnostic.diagnostic).toBe("index-timings");
    expect(Object.keys(diagnostic.phases)).toEqual(INDEX_TIMING_PHASES);
    expect(diagnostic.phases.writerOpen).toEqual({ calls: 0, elapsedMs: 0 });
    expect(diagnostic.phases.total).toEqual({ calls: 3, elapsedMs: 12.346 });
  });
});
