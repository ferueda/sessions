export type CapturedIteratorFailure =
  | { readonly caught: false }
  | { readonly caught: true; readonly error: unknown };

/** Close every iterator while retaining an in-flight scan failure as primary. */
export function closeSqliteIterators(
  iterators: readonly (Iterator<unknown> | undefined)[],
  operationFailure: CapturedIteratorFailure = { caught: false },
): void {
  const cleanupErrors: unknown[] = [];
  for (const iterator of iterators) {
    try {
      iterator?.return?.();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length === 0) return;
  if (operationFailure.caught) {
    throw new AggregateError(
      [operationFailure.error, ...cleanupErrors],
      "SQLite scan and iterator cleanup both failed",
      { cause: operationFailure.error },
    );
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  throw new AggregateError(cleanupErrors, "SQLite iterator cleanup failed", {
    cause: cleanupErrors[0],
  });
}
