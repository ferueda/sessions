export type DoctorHealthPhase =
  | "library-state"
  | "canonical"
  | "capture-scope"
  | "foreign-keys"
  | "content-reachability"
  | "fts-structure"
  | "fts-content"
  | "fts-semantic"
  | "fts-security"
  | "page-reclamation"
  | "run-records"
  | "writer-lease";

export interface DoctorProgressEvent {
  readonly phase: DoctorHealthPhase;
}

export type DoctorProgressObserver = (event: DoctorProgressEvent) => void;

/** Report bounded progress without letting terminal feedback affect doctor. */
export function reportDoctorProgress(
  observer: DoctorProgressObserver | undefined,
  event: DoctorProgressEvent,
): void {
  try {
    observer?.(Object.freeze({ ...event }));
  } catch {
    // Progress is best-effort and must never replace the health result.
  }
}
