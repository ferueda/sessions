export const DOCTOR_TIMING_PHASES = [
  "sourceResolution",
  "libraryState",
  "canonicalIntegrity",
  "captureScope",
  "foreignKeys",
  "contentReachability",
  "ftsStructure",
  "ftsContent",
  "ftsSemantic",
  "ftsSecurity",
  "pageReclamation",
  "runRecords",
  "writerLease",
  "total",
] as const;

export type DoctorTimingPhase = (typeof DOCTOR_TIMING_PHASES)[number];

export interface DoctorTimingRecorder {
  now(): number;
  record(phase: DoctorTimingPhase, elapsedMilliseconds: number): void;
}

/** Measure one existing async operation without letting diagnostics affect it. */
export async function timeDoctorOperation<T>(
  recorder: DoctorTimingRecorder | undefined,
  phase: DoctorTimingPhase,
  operation: () => Promise<T>,
): Promise<T> {
  if (recorder === undefined) return operation();

  const startedAt = readMonotonicClock(recorder);
  try {
    return await operation();
  } finally {
    recordElapsed(recorder, phase, startedAt);
  }
}

/** Measure synchronous health work without letting diagnostics affect it. */
export function timeDoctorSyncOperation<T>(
  recorder: DoctorTimingRecorder | undefined,
  phase: DoctorTimingPhase,
  operation: () => T,
): T {
  if (recorder === undefined) return operation();

  const startedAt = readMonotonicClock(recorder);
  try {
    return operation();
  } finally {
    recordElapsed(recorder, phase, startedAt);
  }
}

function recordElapsed(
  recorder: DoctorTimingRecorder,
  phase: DoctorTimingPhase,
  startedAt: number | undefined,
): void {
  if (startedAt === undefined) return;
  const finishedAt = readMonotonicClock(recorder);
  if (finishedAt === undefined || finishedAt < startedAt) return;
  try {
    recorder.record(phase, finishedAt - startedAt);
  } catch {
    // Timing is diagnostic-only and must never replace the operation result.
  }
}

function readMonotonicClock(recorder: DoctorTimingRecorder): number | undefined {
  try {
    const value = recorder.now();
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
