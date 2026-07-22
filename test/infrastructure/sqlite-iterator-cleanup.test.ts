import { describe, expect, test, vi } from "vitest";

import { closeSqliteIterators } from "../../src/infrastructure/sqlite/iterator-cleanup.ts";

type IteratorReturn = NonNullable<Iterator<unknown>["return"]>;

describe("SQLite iterator cleanup", () => {
  test("attempts every close and aggregates cleanup failures", () => {
    const firstFailure = new Error("first close failed");
    const secondFailure = new Error("second close failed");
    const first = failingIterator(firstFailure);
    const second = failingIterator(secondFailure);
    const third = successfulIterator();

    const failure = captureFailure(() =>
      closeSqliteIterators([first.iterator, second.iterator, third.iterator]),
    );

    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
    expect(third.close).toHaveBeenCalledOnce();
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([firstFailure, secondFailure]);
  });

  test("keeps an operation failure first while attempting every close", () => {
    const operationFailure = new Error("scan failed");
    const cleanupFailure = new Error("close failed");
    const failing = failingIterator(cleanupFailure);
    const successful = successfulIterator();

    const failure = captureFailure(() =>
      closeSqliteIterators([failing.iterator, successful.iterator], {
        caught: true,
        error: operationFailure,
      }),
    );

    expect(failing.close).toHaveBeenCalledOnce();
    expect(successful.close).toHaveBeenCalledOnce();
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([operationFailure, cleanupFailure]);
    expect((failure as AggregateError).cause).toBe(operationFailure);
  });
});

function failingIterator(error: Error): {
  readonly iterator: Iterator<unknown>;
  readonly close: ReturnType<typeof vi.fn<IteratorReturn>>;
} {
  const close = vi.fn<IteratorReturn>(() => {
    throw error;
  });
  return { iterator: { next: () => ({ done: true, value: undefined }), return: close }, close };
}

function successfulIterator(): {
  readonly iterator: Iterator<unknown>;
  readonly close: ReturnType<typeof vi.fn<IteratorReturn>>;
} {
  const close = vi.fn<IteratorReturn>(() => ({ done: true, value: undefined }));
  return { iterator: { next: () => ({ done: true, value: undefined }), return: close }, close };
}

function captureFailure(operation: () => void): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to fail");
}
