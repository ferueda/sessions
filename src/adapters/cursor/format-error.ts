export type CursorFormatFailure = "malformed" | "unsupported-format";

/** Sanitized failure from the frozen Cursor v1 storage contract. */
export class CursorFormatError extends Error {
  readonly kind: CursorFormatFailure;

  constructor(kind: CursorFormatFailure, options?: { readonly cause?: unknown }) {
    super(
      "Cursor session data does not match the supported local format",
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "CursorFormatError";
    this.kind = kind;
  }
}

export function malformedCursorFormat(cause?: unknown): never {
  throw new CursorFormatError("malformed", cause === undefined ? undefined : { cause });
}

export function unsupportedCursorFormat(cause?: unknown): never {
  throw new CursorFormatError("unsupported-format", cause === undefined ? undefined : { cause });
}
