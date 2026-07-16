export const INDEX_TIMING_PHASES = [
  "sourceResolution",
  "writerOpen",
  "sourceProbe",
  "sourceDiscovery",
  "freshnessRead",
  "unchangedWrite",
  "changedReadAndNormalize",
  "replacement",
  "reconciliation",
  "runBookkeeping",
  "writerClose",
  "total",
] as const;

export type IndexTimingPhase = (typeof INDEX_TIMING_PHASES)[number];

export interface IndexTimingRecorder {
  now(): number;
  record(phase: IndexTimingPhase, elapsedMilliseconds: number): void;
}

/** Measure one existing operation without letting diagnostics affect its outcome. */
export async function timeIndexOperation<T>(
  recorder: IndexTimingRecorder | undefined,
  phase: IndexTimingPhase,
  operation: () => Promise<T>,
): Promise<T> {
  if (recorder === undefined) return operation();

  const startedAt = readMonotonicClock(recorder);
  try {
    return await operation();
  } finally {
    if (startedAt !== undefined) {
      const finishedAt = readMonotonicClock(recorder);
      if (finishedAt !== undefined && finishedAt >= startedAt) {
        try {
          recorder.record(phase, finishedAt - startedAt);
        } catch {
          // Timing is diagnostic-only and must never replace the operation result.
        }
      }
    }
  }
}

function readMonotonicClock(recorder: IndexTimingRecorder): number | undefined {
  try {
    const value = recorder.now();
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
