import { describe, expect, test, vi } from "vitest";

import {
  timeIndexOperation,
  type IndexTimingRecorder,
} from "../../src/application/index-timing.ts";

interface BrokenRecorderCase {
  readonly label: string;
  readonly create: () => IndexTimingRecorder;
}

const BROKEN_RECORDER_CASES: readonly BrokenRecorderCase[] = [
  {
    label: "throwing start clock",
    create: () => ({
      now() {
        throw new Error("private start clock failure");
      },
      record: vi.fn<IndexTimingRecorder["record"]>(),
    }),
  },
  {
    label: "invalid start clock",
    create: () => ({
      now: () => Number.NaN,
      record: vi.fn<IndexTimingRecorder["record"]>(),
    }),
  },
  {
    label: "throwing finish clock",
    create: () => sequenceRecorder([10, new Error("private finish clock failure")]),
  },
  {
    label: "invalid finish clock",
    create: () => sequenceRecorder([10, Number.POSITIVE_INFINITY]),
  },
  {
    label: "decreasing clock",
    create: () => sequenceRecorder([10, 9]),
  },
  {
    label: "throwing recorder",
    create: () => ({
      ...sequenceRecorder([10, 12]),
      record() {
        throw new Error("private recorder failure");
      },
    }),
  },
];

describe("timeIndexOperation", () => {
  test("executes an operation once and records its elapsed time", async () => {
    const operation = vi.fn<() => Promise<{ readonly outcome: "preserved" }>>(async () => ({
      outcome: "preserved",
    }));
    const record = vi.fn<IndexTimingRecorder["record"]>();
    const recorder = sequenceRecorder([100, 107.25], record);

    await expect(timeIndexOperation(recorder, "writerOpen", operation)).resolves.toEqual({
      outcome: "preserved",
    });

    expect(operation).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledExactlyOnceWith("writerOpen", 7.25);
  });

  test("executes an operation directly when timing is disabled", async () => {
    const operation = vi.fn<() => Promise<string>>(async () => "result");

    await expect(timeIndexOperation(undefined, "writerOpen", operation)).resolves.toBe("result");

    expect(operation).toHaveBeenCalledOnce();
  });

  test.each(BROKEN_RECORDER_CASES)(
    "preserves a resolved result with a $label",
    async ({ create }) => {
      const result = Object.freeze({ outcome: "original" as const });
      const operation = vi.fn<() => Promise<typeof result>>(async () => result);

      await expect(timeIndexOperation(create(), "writerOpen", operation)).resolves.toBe(result);

      expect(operation).toHaveBeenCalledOnce();
    },
  );

  test.each(BROKEN_RECORDER_CASES)(
    "preserves the original rejection with a $label",
    async ({ create }) => {
      const error = new Error("original operation failure");
      const operation = vi.fn<() => Promise<never>>(async () => {
        throw error;
      });

      await expect(timeIndexOperation(create(), "writerClose", operation)).rejects.toBe(error);

      expect(operation).toHaveBeenCalledOnce();
    },
  );
});

function sequenceRecorder(
  values: readonly (number | Error)[],
  record: IndexTimingRecorder["record"] = vi.fn<IndexTimingRecorder["record"]>(),
): IndexTimingRecorder {
  let index = 0;
  return {
    now() {
      const value = values[index++];
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error("Timing test clock exhausted");
      return value;
    },
    record,
  };
}
