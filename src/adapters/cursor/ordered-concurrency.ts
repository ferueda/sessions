const CURSOR_FILESYSTEM_CONCURRENCY = 8;

/**
 * Run independent inventory leaves concurrently without changing their serial order.
 */
export async function mapCursorInventoryInOrder<Input, Output>(
  inputs: readonly Input[],
  operation: (input: Input, index: number) => Promise<Output>,
): Promise<readonly Output[]> {
  const results: Output[] = [];
  results.length = inputs.length;
  const failures: { readonly index: number; readonly error: unknown }[] = [];
  let nextIndex = 0;
  let failureObserved = false;

  async function worker(): Promise<void> {
    while (!failureObserved) {
      const index = nextIndex;
      if (index >= inputs.length) return;
      nextIndex += 1;
      try {
        results[index] = await operation(inputs[index]!, index);
      } catch (error) {
        failures.push({ index, error });
        failureObserved = true;
      }
    }
  }

  const workerCount = Math.min(CURSOR_FILESYSTEM_CONCURRENCY, inputs.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  if (failures.length > 0) {
    failures.sort((left, right) => left.index - right.index);
    throw failures[0]!.error;
  }
  return Object.freeze(results);
}
