import { Buffer } from "node:buffer";

export const MAX_BOUNDED_STRUCTURED_OUTPUT_BYTES = 16 * 1024 * 1024;
export const STRUCTURED_OUTPUT_TOO_LARGE = "structured-output-too-large" as const;

export interface StructuredOutputEncodingOptions {
  /** Internal seam for deterministic boundary tests. */
  readonly maximumBytesForTest?: number;
  /** Only the explicit `export --full` route may set this in production. */
  readonly exemptFromLimit?: boolean;
}

export class StructuredOutputTooLargeError extends Error {
  readonly code = STRUCTURED_OUTPUT_TOO_LARGE;

  constructor() {
    super("structured-output-too-large: narrow list/search/entries/manifest or use export --full");
    this.name = "StructuredOutputTooLargeError";
  }
}

export function admitEncodedStructuredOutput(
  encoded: string,
  options: StructuredOutputEncodingOptions = {},
): string {
  if (options.exemptFromLimit === true) return encoded;
  const maximum = options.maximumBytesForTest ?? MAX_BOUNDED_STRUCTURED_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 0) {
    throw new TypeError("Structured output byte limit is invalid");
  }
  if (Buffer.byteLength(encoded, "utf8") > maximum) {
    throw new StructuredOutputTooLargeError();
  }
  return encoded;
}
