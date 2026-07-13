import type { SessionValidationIssue } from "../domain/session-validation.ts";
import type { SourceInstance } from "../domain/session.ts";

export type MalformedSourceReason =
  | "adapter-read-failed"
  | "candidate-kind-mismatch"
  | "document-identity-mismatch"
  | "invalid-session-document";

export interface SafeSessionValidationFailure {
  readonly issues: readonly SessionValidationIssue[];
  readonly truncated: boolean;
}

export type SourceFailure =
  | { readonly kind: "unavailable"; readonly source: SourceInstance }
  | { readonly kind: "unreadable"; readonly source: SourceInstance }
  | {
      readonly kind: "malformed";
      readonly source: SourceInstance;
      readonly reason?: MalformedSourceReason;
      readonly validation?: SafeSessionValidationFailure;
    }
  | { readonly kind: "source-changed"; readonly source: SourceInstance }
  | { readonly kind: "unsupported-format"; readonly source: SourceInstance };

const SOURCE_FAILURE_MESSAGES = {
  unavailable: "Session source is unavailable",
  unreadable: "Session source is unreadable",
  malformed: "Session source data is malformed",
  "source-changed": "Session source changed while it was read",
  "unsupported-format": "Session source format is unsupported",
} as const satisfies Record<SourceFailure["kind"], string>;

export class SourceFailureError extends Error {
  readonly failure: SourceFailure;

  constructor(failure: SourceFailure, options?: { readonly cause?: unknown }) {
    super(
      SOURCE_FAILURE_MESSAGES[failure.kind],
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "SourceFailureError";
    this.failure = failure;
  }
}

export function isSourceFailureError(error: unknown): error is SourceFailureError {
  return error instanceof SourceFailureError;
}
