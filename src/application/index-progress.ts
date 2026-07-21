export type IndexWriterOpenMode = "fast" | "bootstrap" | "full-validation";

export type IndexWriterValidationPhase =
  | "canonical"
  | "foreign-keys"
  | "fts-structure"
  | "fts-content"
  | "fts-semantic"
  | "fts-rebuild";

export type IndexProgressEvent =
  | {
      readonly kind: "writer-open-mode";
      readonly mode: IndexWriterOpenMode;
    }
  | {
      readonly kind: "writer-validation";
      readonly phase: IndexWriterValidationPhase;
    };

export type IndexProgressObserver = (event: IndexProgressEvent) => void;

/** Report bounded progress without letting terminal feedback affect indexing. */
export function reportIndexProgress(
  observer: IndexProgressObserver | undefined,
  event: IndexProgressEvent,
): void {
  try {
    observer?.(Object.freeze({ ...event }));
  } catch {
    // Progress is best-effort and must never replace the operation result.
  }
}
