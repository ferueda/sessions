import { SessionLibraryError } from "./library-error.ts";

export const MAX_SESSION_ENTRY_RANGE_COUNT = 200;

export interface SessionEntryRange {
  readonly fromEntry: number;
  readonly toEntry: number;
}

export function admitSessionEntryRange(input: {
  readonly fromEntry?: number;
  readonly toEntry?: number;
}): SessionEntryRange | undefined {
  if (input.fromEntry === undefined && input.toEntry === undefined) return undefined;
  if (input.fromEntry === undefined || input.toEntry === undefined) {
    throw new TypeError("Entry range requires both from-entry and to-entry");
  }
  if (!isNonNegativeSafeInteger(input.fromEntry)) {
    throw new TypeError("From entry must be a non-negative safe integer");
  }
  if (!isNonNegativeSafeInteger(input.toEntry)) {
    throw new TypeError("To entry must be a non-negative safe integer");
  }
  if (input.fromEntry > input.toEntry) {
    throw new TypeError("Entry range must not be reversed");
  }
  if (input.toEntry - input.fromEntry >= MAX_SESSION_ENTRY_RANGE_COUNT) {
    throw new TypeError(`Entry range may contain at most ${MAX_SESSION_ENTRY_RANGE_COUNT} entries`);
  }

  return Object.freeze({ fromEntry: input.fromEntry, toEntry: input.toEntry });
}

export function resolveSessionEntryWindow(
  range: SessionEntryRange,
  entryCount: number,
): { readonly start: number; readonly end: number } {
  if (!isNonNegativeSafeInteger(entryCount)) {
    throw new TypeError("Session entry count must be a non-negative safe integer");
  }
  if (range.fromEntry >= entryCount || range.toEntry >= entryCount) {
    throw new SessionLibraryError("entry-not-found");
  }

  return Object.freeze({ start: range.fromEntry, end: range.toEntry + 1 });
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
