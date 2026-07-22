import { describe, expect, test, vi } from "vitest";

import {
  reportDoctorProgress,
  type DoctorProgressObserver,
} from "../../src/application/doctor-progress.ts";

describe("doctor progress", () => {
  test("reports a frozen copy and ignores observer failures", () => {
    const observer = vi.fn<DoctorProgressObserver>(() => {
      throw new Error("terminal failure");
    });

    expect(() => reportDoctorProgress(observer, { phase: "canonical" })).not.toThrow();
    expect(observer).toHaveBeenCalledOnce();
    expect(observer.mock.calls[0]?.[0]).toEqual({ phase: "canonical" });
    expect(Object.isFrozen(observer.mock.calls[0]?.[0])).toBe(true);
  });
});
