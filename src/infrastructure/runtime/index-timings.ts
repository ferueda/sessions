import { performance } from "node:perf_hooks";

import {
  INDEX_TIMING_PHASES,
  type IndexTimingPhase,
  type IndexTimingRecorder,
} from "../../application/index-timing.ts";

const INDEX_TIMING_DIAGNOSTIC_PREFIX = "sessions:index-timings ";

export interface IndexTimingPhaseAggregate {
  readonly calls: number;
  readonly elapsedMs: number;
}

export type IndexTimingPhases = Readonly<{
  [Phase in IndexTimingPhase]: IndexTimingPhaseAggregate;
}>;

export interface IndexTimingSnapshot {
  readonly diagnostic: "index-timings";
  readonly phases: IndexTimingPhases;
}

export interface IndexTimingCollector {
  readonly recorder: IndexTimingRecorder;
  snapshot(): IndexTimingSnapshot;
}

export interface IndexTimingCollectorOptions {
  readonly now?: () => number;
}

export function createIndexTimingCollector(
  options: IndexTimingCollectorOptions = {},
): IndexTimingCollector {
  const now = options.now ?? (() => performance.now());
  const totals = new Map<IndexTimingPhase, { calls: number; elapsedMs: number }>(
    INDEX_TIMING_PHASES.map((phase) => [phase, { calls: 0, elapsedMs: 0 }]),
  );
  const recorder: IndexTimingRecorder = Object.freeze({
    now,
    record(phase: IndexTimingPhase, elapsedMilliseconds: number) {
      if (!isIndexTimingPhase(phase) || !isElapsedMilliseconds(elapsedMilliseconds)) return;
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
        diagnostic: "index-timings" as const,
        phases: snapshotPhases(totals),
      });
    },
  });
}

export function encodeIndexTimingDiagnostic(snapshot: IndexTimingSnapshot): string {
  const phases = Object.fromEntries(
    INDEX_TIMING_PHASES.map((phase) => {
      const aggregate = snapshot.phases[phase];
      return [
        phase,
        {
          calls: safeCallCount(aggregate.calls),
          elapsedMs: roundMilliseconds(aggregate.elapsedMs),
        },
      ];
    }),
  ) as IndexTimingPhases;
  return `${INDEX_TIMING_DIAGNOSTIC_PREFIX}${JSON.stringify({
    diagnostic: "index-timings",
    phases,
  })}\n`;
}

function snapshotPhases(
  totals: ReadonlyMap<IndexTimingPhase, { readonly calls: number; readonly elapsedMs: number }>,
): IndexTimingPhases {
  return Object.freeze(
    Object.fromEntries(
      INDEX_TIMING_PHASES.map((phase) => {
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
  ) as IndexTimingPhases;
}

function isIndexTimingPhase(value: string): value is IndexTimingPhase {
  return INDEX_TIMING_PHASES.some((phase) => phase === value);
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
