import { describe, expect, test, vi } from "vitest";

import {
  timeDoctorOperation,
  timeDoctorSyncOperation,
  type DoctorTimingRecorder,
} from "../../src/application/doctor-timing.ts";

describe("doctor timing", () => {
  test("records async and synchronous health work", async () => {
    const record = vi.fn<DoctorTimingRecorder["record"]>();
    const recorder = sequenceRecorder([10, 12.5, 20, 24], record);

    await expect(timeDoctorOperation(recorder, "libraryState", async () => "ready")).resolves.toBe(
      "ready",
    );
    expect(timeDoctorSyncOperation(recorder, "canonicalIntegrity", () => true)).toBe(true);

    expect(record).toHaveBeenNthCalledWith(1, "libraryState", 2.5);
    expect(record).toHaveBeenNthCalledWith(2, "canonicalIntegrity", 4);
  });

  test("preserves operation results and failures when diagnostics fail", async () => {
    const broken: DoctorTimingRecorder = {
      now() {
        throw new Error("private clock failure");
      },
      record() {
        throw new Error("private recorder failure");
      },
    };
    const failure = new Error("health failure");

    await expect(timeDoctorOperation(broken, "total", async () => "ok")).resolves.toBe("ok");
    expect(timeDoctorSyncOperation(broken, "ftsSemantic", () => 42)).toBe(42);
    await expect(
      timeDoctorOperation(broken, "total", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});

function sequenceRecorder(
  values: readonly number[],
  record: DoctorTimingRecorder["record"],
): DoctorTimingRecorder {
  let index = 0;
  return {
    now() {
      const value = values[index++];
      if (value === undefined) throw new Error("Timing test clock exhausted");
      return value;
    },
    record,
  };
}
