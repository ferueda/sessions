export type SessionLibraryErrorCode =
  | "entry-not-found"
  | "library-busy"
  | "library-unavailable"
  | "session-not-found";

export class SessionLibraryError extends Error {
  readonly code: SessionLibraryErrorCode;

  constructor(code: SessionLibraryErrorCode, options?: { readonly cause?: unknown }) {
    super(libraryErrorMessage(code), options);
    this.name = "SessionLibraryError";
    this.code = code;
  }
}

function libraryErrorMessage(code: SessionLibraryErrorCode): string {
  switch (code) {
    case "entry-not-found":
      return "Session entry was not found";
    case "library-busy":
      return "Session library is busy";
    case "library-unavailable":
      return "Session library is unavailable";
    case "session-not-found":
      return "Session was not found";
  }
}

/** Hide lease-layer vocabulary at the application/CLI boundary. */
export function mapLibraryBusyError(error: unknown): unknown {
  return hasBusyCode(error) ? new SessionLibraryError("library-busy", { cause: error }) : error;
}

function hasBusyCode(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && (error.code === "writer-busy" || error.code === "library-busy")) {
    return true;
  }
  if (error instanceof AggregateError && error.errors.some(hasBusyCode)) return true;
  return "cause" in error && hasBusyCode(error.cause);
}
