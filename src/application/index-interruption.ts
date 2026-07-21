export class IndexInterruptedError extends Error {
  constructor() {
    super("Session indexing was interrupted");
    this.name = "IndexInterruptedError";
  }
}

export function throwIfIndexInterrupted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new IndexInterruptedError();
}

export function isIndexInterruptedError(error: unknown): error is IndexInterruptedError {
  return error instanceof IndexInterruptedError;
}
