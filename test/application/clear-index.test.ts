import { describe, expect, test, vi } from "vitest";

import { clearData } from "../../src/application/clear-index.ts";
import type { IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import {
  IndexMaintenanceError,
  type IndexMaintenance,
} from "../../src/application/ports/index-maintenance.ts";

const paths: IndexPaths = {
  directory: "/cache/sessions",
  scratch: "/cache/sessions/.scratch",
  database: "/cache/sessions/sessions.sqlite3",
  wal: "/cache/sessions/sessions.sqlite3-wal",
  shm: "/cache/sessions/sessions.sqlite3-shm",
};

describe("clearData", () => {
  test("returns the exact versioned absent report", async () => {
    const maintenance: IndexMaintenance = {
      clear: vi.fn<IndexMaintenance["clear"]>().mockResolvedValue({
        outcome: "absent",
        scratchRemoved: false,
        databaseRemoved: false,
        walRemoved: false,
        shmRemoved: false,
      }),
      compact: vi.fn<IndexMaintenance["compact"]>(),
      forget: vi.fn<IndexMaintenance["forget"]>(),
    };

    await expect(clearData(paths, maintenance)).resolves.toEqual({
      schemaVersion: 1,
      command: "data-clear",
      outcome: "absent",
      scratchRemoved: false,
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
        scratchRemoved: true,
        databaseRemoved: true,
        walRemoved: true,
        shmRemoved: false,
      }),
      compact: vi.fn<IndexMaintenance["compact"]>(),
      forget: vi.fn<IndexMaintenance["forget"]>(),
    };

    await expect(clearData(paths, maintenance)).resolves.toEqual({
      schemaVersion: 1,
      command: "data-clear",
      outcome: "cleared",
      scratchRemoved: true,
      databaseRemoved: true,
      walRemoved: true,
      shmRemoved: false,
    });
  });

  test("preserves a maintenance failure", async () => {
    const failure = new Error("maintenance failed");
    const maintenance: IndexMaintenance = {
      clear: vi.fn<IndexMaintenance["clear"]>().mockRejectedValue(failure),
      compact: vi.fn<IndexMaintenance["compact"]>(),
      forget: vi.fn<IndexMaintenance["forget"]>(),
    };

    await expect(clearData(paths, maintenance)).rejects.toBe(failure);
  });

  test("maps writer contention to the public library-busy failure", async () => {
    const busy = new IndexMaintenanceError("library-busy");
    const maintenance: IndexMaintenance = {
      clear: vi.fn<IndexMaintenance["clear"]>().mockRejectedValue(busy),
      compact: vi.fn<IndexMaintenance["compact"]>(),
      forget: vi.fn<IndexMaintenance["forget"]>(),
    };

    await expect(clearData(paths, maintenance)).rejects.toMatchObject({
      code: "library-busy",
      message: "Session library is busy",
      cause: busy,
    });
  });
});
