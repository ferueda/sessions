import { EventEmitter } from "node:events";

import { describe, expect, test, vi } from "vitest";

import {
  installIndexInterrupt,
  type IndexProcessSignal,
  type ProcessSignalSource,
} from "../../src/infrastructure/runtime/index-interrupt.ts";

describe("index process interruption", () => {
  test.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("maps the first %s and restores later signal handling", (signal, exitCode) => {
    const source = new FakeSignalSource();
    const interrupt = installIndexInterrupt(source);

    source.emit(signal);

    expect(interrupt.signal.aborted).toBe(true);
    expect(interrupt.interruption).toEqual({ signal, exitCode });
    expect(source.listenerCount("SIGINT")).toBe(0);
    expect(source.listenerCount("SIGTERM")).toBe(0);

    source.emit(signal === "SIGINT" ? "SIGTERM" : "SIGINT");
    expect(interrupt.interruption).toEqual({ signal, exitCode });
  });

  test("dispose removes both handlers without requesting cancellation", () => {
    const source = new FakeSignalSource();
    const interrupt = installIndexInterrupt(source);

    interrupt.dispose();
    source.emit("SIGINT");

    expect(interrupt.signal.aborted).toBe(false);
    expect(interrupt.interruption).toBeUndefined();
    expect(source.off).toHaveBeenCalledTimes(2);
  });
});

class FakeSignalSource implements ProcessSignalSource {
  readonly #events = new EventEmitter();
  readonly off = vi.fn<(signal: IndexProcessSignal, listener: () => void) => void>(
    (signal, listener) => {
      this.#events.off(signal, listener);
    },
  );

  once(signal: IndexProcessSignal, listener: () => void): void {
    this.#events.once(signal, listener);
  }

  emit(signal: IndexProcessSignal): void {
    this.#events.emit(signal);
  }

  listenerCount(signal: IndexProcessSignal): number {
    return this.#events.listenerCount(signal);
  }
}
