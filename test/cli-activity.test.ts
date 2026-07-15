import { afterEach, describe, expect, test, vi } from "vitest";

import { withCliActivity } from "../src/cli/activity.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("CLI activity", () => {
  test("shows immediate elapsed activity and clears it after success", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const events: string[] = [];
    let clears = 0;
    let finish!: (value: number) => void;
    const operation = new Promise<number>((resolve) => {
      finish = resolve;
    });

    const result = withCliActivity(
      {
        stderrIsInteractive: true,
        writeErr: (text) => {
          writes.push(text);
          events.push(`write:${text}`);
        },
        clearErrLine: () => {
          clears += 1;
          events.push("clear");
        },
      },
      "Indexing sessions",
      () => {
        events.push("operation");
        return operation;
      },
    );

    expect(writes).toEqual(["- Indexing sessions (0s)"]);
    expect(events.slice(0, 3)).toEqual(["clear", "write:- Indexing sessions (0s)", "operation"]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(writes).toEqual([
      "- Indexing sessions (0s)",
      "\\ Indexing sessions (1s)",
      "| Indexing sessions (2s)",
    ]);

    finish(42);
    await expect(result).resolves.toBe(42);
    expect(clears).toBe(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("stays silent without an interactive stderr", async () => {
    const writeErr = vi.fn<(text: string) => void>();
    const clearErrLine = vi.fn<() => void>();
    const operation = vi.fn<() => Promise<string>>(async () => "done");

    await expect(
      withCliActivity({ writeErr, clearErrLine }, "Indexing sessions", operation),
    ).resolves.toBe("done");

    expect(operation).toHaveBeenCalledOnce();
    expect(writeErr).not.toHaveBeenCalled();
    expect(clearErrLine).not.toHaveBeenCalled();
  });

  test("cleans up after failure without replacing the operation error", async () => {
    const failure = new Error("operation failed");
    const clearErrLine = vi.fn<() => void>();

    await expect(
      withCliActivity(
        {
          stderrIsInteractive: true,
          writeErr: vi.fn<(text: string) => void>(),
          clearErrLine,
        },
        "Compacting Sessions data",
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);

    expect(clearErrLine).toHaveBeenCalledTimes(2);
  });

  test("does not let terminal feedback failure abort the operation", async () => {
    const clearErrLine = vi.fn<() => void>();

    await expect(
      withCliActivity(
        {
          stderrIsInteractive: true,
          writeErr: () => {
            throw new Error("stderr unavailable");
          },
          clearErrLine,
        },
        "Repairing orphaned content",
        async () => "repaired",
      ),
    ).resolves.toBe("repaired");

    expect(clearErrLine).toHaveBeenCalledTimes(2);
  });
});
