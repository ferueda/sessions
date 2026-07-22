import { describe, expect, test } from "vitest";

import { mapCursorInventoryInOrder } from "../../../src/adapters/cursor/ordered-concurrency.ts";

describe("ordered Cursor inventory concurrency", () => {
  test("bounds active work at eight", async () => {
    let active = 0;
    let maximumActive = 0;
    const results = await mapCursorInventoryInOrder(
      Array.from({ length: 24 }, (_, index) => index),
      async (index) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active -= 1;
        return `result-${index}`;
      },
    );

    expect(results).toEqual(Array.from({ length: 24 }, (_, index) => `result-${index}`));
    expect(Object.isFrozen(results)).toBe(true);
    expect(maximumActive).toBe(8);
  });

  test("returns reverse completion in input order", async () => {
    const gates = Array.from({ length: 8 }, () => Promise.withResolvers<void>());
    const completed: number[] = [];
    const pending = mapCursorInventoryInOrder(gates, async (gate, index) => {
      await gate.promise;
      completed.push(index);
      return `result-${index}`;
    });

    for (let index = 7; index >= 0; index -= 1) {
      gates[index]!.resolve();
      await waitFor(() => completed.includes(index));
    }

    await expect(pending).resolves.toEqual(
      Array.from({ length: 8 }, (_, index) => `result-${index}`),
    );
    expect(completed).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
  });

  test("throws the lowest-ordinal started failure after all started work settles", async () => {
    const gates = Array.from({ length: 12 }, () => Promise.withResolvers<void>());
    const started: number[] = [];
    const settled: number[] = [];
    const pending = mapCursorInventoryInOrder(gates, async (gate, index) => {
      started.push(index);
      try {
        await gate.promise;
        if (index === 2 || index === 7) throw new Error(`failure-${index}`);
        return index;
      } finally {
        settled.push(index);
      }
    });

    await waitFor(() => started.length === 8);
    gates[7]!.resolve();
    await waitFor(() => settled.includes(7));
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    for (let index = 0; index < 7; index += 1) gates[index]!.resolve();

    await expect(pending).rejects.toThrow("failure-2");
    expect(settled.toSorted((left, right) => left - right)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for ordered concurrency test state");
}
