import { performance } from "node:perf_hooks";

import {
  DOCTOR_TIMING_PHASES,
  type DoctorTimingPhase,
  type DoctorTimingRecorder,
} from "../../application/doctor-timing.ts";

const DOCTOR_TIMING_DIAGNOSTIC_PREFIX = "sessions:doctor-timings ";

export interface DoctorTimingPhaseAggregate {
  readonly calls: number;
  readonly elapsedMs: number;
}

export type DoctorTimingPhases = Readonly<{
  [Phase in DoctorTimingPhase]: DoctorTimingPhaseAggregate;
}>;

export interface DoctorTimingSnapshot {
  readonly diagnostic: "doctor-timings";
  readonly phases: DoctorTimingPhases;
}

export interface DoctorTimingCollector {
  readonly recorder: DoctorTimingRecorder;
  snapshot(): DoctorTimingSnapshot;
}

export interface DoctorTimingCollectorOptions {
  readonly now?: () => number;
}

export function createDoctorTimingCollector(
  options: DoctorTimingCollectorOptions = {},
): DoctorTimingCollector {
  const now = options.now ?? (() => performance.now());
  const totals = new Map<DoctorTimingPhase, { calls: number; elapsedMs: number }>(
    DOCTOR_TIMING_PHASES.map((phase) => [phase, { calls: 0, elapsedMs: 0 }]),
  );
  const recorder: DoctorTimingRecorder = Object.freeze({
    now,
    record(phase: DoctorTimingPhase, elapsedMilliseconds: number) {
      if (!isDoctorTimingPhase(phase) || !isElapsedMilliseconds(elapsedMilliseconds)) return;
      const total = totals.get(phase);
      if (total === undefined || total.calls >= Number.MAX_SAFE_INTEGER) return;
      const elapsedMs = total.elapsedMs + elapsedMilliseconds;
      if (!Number.isFinite(elapsedMs)) return;
      total.calls += 1;
      total.elapsedMs = elapsedMs;
    },
  });

  return Object.freeze({
    recorder,
    snapshot() {
      return Object.freeze({
        diagnostic: "doctor-timings" as const,
        phases: snapshotPhases(totals),
      });
    },
  });
}

export function encodeDoctorTimingDiagnostic(snapshot: DoctorTimingSnapshot): string {
  const phases = Object.fromEntries(
    DOCTOR_TIMING_PHASES.map((phase) => {
      const aggregate = snapshot.phases[phase];
      return [
        phase,
        {
          calls: safeCallCount(aggregate.calls),
          elapsedMs: roundMilliseconds(aggregate.elapsedMs),
        },
      ];
    }),
  ) as DoctorTimingPhases;
  return `${DOCTOR_TIMING_DIAGNOSTIC_PREFIX}${JSON.stringify({
    diagnostic: "doctor-timings",
    phases,
  })}\n`;
}

function snapshotPhases(
  totals: ReadonlyMap<DoctorTimingPhase, { readonly calls: number; readonly elapsedMs: number }>,
): DoctorTimingPhases {
  return Object.freeze(
    Object.fromEntries(
      DOCTOR_TIMING_PHASES.map((phase) => {
        const aggregate = totals.get(phase);
        return [
          phase,
          Object.freeze({
            calls: safeCallCount(aggregate?.calls),
            elapsedMs: roundMilliseconds(aggregate?.elapsedMs),
          }),
        ];
      }),
    ),
  ) as DoctorTimingPhases;
}

function isDoctorTimingPhase(value: string): value is DoctorTimingPhase {
  return DOCTOR_TIMING_PHASES.some((phase) => phase === value);
}

function isElapsedMilliseconds(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function safeCallCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function roundMilliseconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.round(value * 1_000) / 1_000;
}
