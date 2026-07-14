import { describe, expect, test, vi } from "vitest";

import { clearIndex } from "../../src/application/clear-index.ts";
import type { IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import type { IndexMaintenance } from "../../src/application/ports/index-maintenance.ts";

const paths: IndexPaths = {
  directory: "/cache/sessions",
  database: "/cache/sessions/index.sqlite3",
  wal: "/cache/sessions/index.sqlite3-wal",
  shm: "/cache/sessions/index.sqlite3-shm",
};

describe("clearIndex", () => {
  test("returns the exact versioned absent report", async () => {
    const maintenance: IndexMaintenance = {
      clear: vi.fn<IndexMaintenance["clear"]>().mockResolvedValue({
        outcome: "absent",
        databaseRemoved: false,
        walRemoved: false,
        shmRemoved: false,
      }),
    };

    await expect(clearIndex(paths, maintenance)).resolves.toEqual({
      schemaVersion: 1,
      command: "index-clear",
      outcome: "absent",
      databaseRemoved: false,
      walRemoved: false,
      shmRemoved: false,
    });
    expect(maintenance.clear).toHaveBeenCalledWith(paths);
  });

  test("returns the exact versioned cleared report", async () => {
    const maintenance: IndexMaintenance = {
      clear: vi.fn<IndexMaintenance["clear"]>().mockResolvedValue({
        outcome: "cleared",
        databaseRemoved: true,
        walRemoved: true,
        shmRemoved: false,
      }),
    };

    await expect(clearIndex(paths, maintenance)).resolves.toEqual({
      schemaVersion: 1,
      command: "index-clear",
      outcome: "cleared",
      databaseRemoved: true,
      walRemoved: true,
      shmRemoved: false,
    });
  });

  test("preserves a maintenance failure", async () => {
    const failure = new Error("maintenance failed");
    const maintenance: IndexMaintenance = {
      clear: vi.fn<IndexMaintenance["clear"]>().mockRejectedValue(failure),
    };

    await expect(clearIndex(paths, maintenance)).rejects.toBe(failure);
  });
});
