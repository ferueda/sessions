import { describe, expect, test } from "vitest";

import {
  DOCTOR_TIMING_PHASES,
  type DoctorTimingPhase,
} from "../../src/application/doctor-timing.ts";
import {
  createDoctorTimingCollector,
  encodeDoctorTimingDiagnostic,
  type DoctorTimingSnapshot,
} from "../../src/infrastructure/runtime/doctor-timings.ts";

describe("doctor timing collector", () => {
  test("aggregates only allowlisted phases", () => {
    const collector = createDoctorTimingCollector({ now: () => 42 });
    collector.recorder.record("ftsSemantic", 1.234_56);
    collector.recorder.record("ftsSemantic", 1.000_06);

    const unsafeRecord = collector.recorder.record as (phase: string, elapsedMs: number) => void;
    unsafeRecord("private-phase", 99);
    unsafeRecord("ftsSemantic", Number.NaN);

    expect(Object.keys(collector.snapshot().phases)).toEqual(DOCTOR_TIMING_PHASES);
    expect(collector.snapshot().phases.ftsSemantic).toEqual({ calls: 2, elapsedMs: 2.235 });
    expect(collector.snapshot().phases).not.toHaveProperty("private-phase");
  });

  test("encodes one fixed sanitized diagnostic line", () => {
    const phases = Object.fromEntries(
      DOCTOR_TIMING_PHASES.map((phase) => [phase, { calls: 0, elapsedMs: 0 }]),
    ) as Record<DoctorTimingPhase, { calls: number; elapsedMs: number }> & {
      privatePhase?: { calls: number; elapsedMs: number; path: string };
    };
    phases.total = { calls: 3, elapsedMs: 12.345_67 };
    phases.privatePhase = { calls: 1, elapsedMs: 99, path: "/private/transcript.jsonl" };

    const encoded = encodeDoctorTimingDiagnostic({
      diagnostic: "doctor-timings",
      phases,
    } as DoctorTimingSnapshot);

    const prefix = "sessions:doctor-timings ";
    expect(encoded.startsWith(prefix)).toBe(true);
    expect(encoded.endsWith("\n")).toBe(true);
    expect(encoded).not.toContain("privatePhase");
    expect(encoded).not.toContain("private/transcript");
    expect(JSON.parse(encoded.slice(prefix.length))).toEqual({
      diagnostic: "doctor-timings",
      phases: expect.objectContaining({ total: { calls: 3, elapsedMs: 12.346 } }),
    });
  });
});
