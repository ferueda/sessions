import { createSessionQueryCursor, type SessionQueryCursor } from "../domain/session-query.ts";

export type SessionQueryUsageErrorCode = "invalid-cursor" | "cursor-query-mismatch";

export class SessionQueryUsageError extends Error {
  readonly code: SessionQueryUsageErrorCode;

  constructor(code: SessionQueryUsageErrorCode, options?: { readonly cause?: unknown }) {
    super(usageMessage(code), options);
    this.name = "SessionQueryUsageError";
    this.code = code;
  }
}

export type SessionQueryOperationalErrorCode = "stale-cursor";

export class SessionQueryOperationalError extends Error {
  readonly code: SessionQueryOperationalErrorCode;

  constructor(code: SessionQueryOperationalErrorCode, options?: { readonly cause?: unknown }) {
    super("Session query cursor is stale", options);
    this.name = "SessionQueryOperationalError";
    this.code = code;
  }
}

export function admitSessionQueryCursor(value: string | undefined): SessionQueryCursor | undefined {
  if (value === undefined) return undefined;
  try {
    return createSessionQueryCursor(value);
  } catch (cause) {
    throw new SessionQueryUsageError("invalid-cursor", { cause });
  }
}

function usageMessage(code: SessionQueryUsageErrorCode): string {
  switch (code) {
    case "invalid-cursor":
      return "Session query cursor is invalid";
    case "cursor-query-mismatch":
      return "Session query cursor does not match this query";
  }
}
