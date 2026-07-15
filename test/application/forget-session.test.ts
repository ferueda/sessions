import { describe, expect, test, vi } from "vitest";

import { forgetSession } from "../../src/application/forget-session.ts";
import type { IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import {
  IndexMaintenanceError,
  type IndexMaintenance,
} from "../../src/application/ports/index-maintenance.ts";
import type { SessionIdentity } from "../../src/domain/session.ts";

const paths: IndexPaths = {
  directory: "/data/sessions",
  scratch: "/data/sessions/.scratch",
  database: "/data/sessions/sessions.sqlite3",
  wal: "/data/sessions/sessions.sqlite3-wal",
  shm: "/data/sessions/sessions.sqlite3-shm",
};
const identity: SessionIdentity = {
  source: { kind: "synthetic", instanceId: "profile/one" },
  nativeId: "session:one",
};

describe("forgetSession", () => {
  test.each(["forgotten", "absent"] as const)("returns the exact %s report", async (outcome) => {
    const maintenance: IndexMaintenance = {
      clear: vi.fn<IndexMaintenance["clear"]>(),
      compact: vi.fn<IndexMaintenance["compact"]>(),
      forget: vi.fn<IndexMaintenance["forget"]>().mockResolvedValue(outcome),
    };

    await expect(forgetSession(paths, maintenance, identity)).resolves.toEqual({
      schemaVersion: 1,
      command: "forget",
      identity: {
        canonicalId: "synthetic@profile%2Fone:session%3Aone",
        source: identity.source,
        nativeId: identity.nativeId,
      },
      outcome,
    });
    expect(maintenance.forget).toHaveBeenCalledWith(paths, identity);
  });

  test("preserves a maintenance failure", async () => {
    const failure = new Error("maintenance failed");
    const maintenance: IndexMaintenance = {
      clear: vi.fn<IndexMaintenance["clear"]>(),
      compact: vi.fn<IndexMaintenance["compact"]>(),
      forget: vi.fn<IndexMaintenance["forget"]>().mockRejectedValue(failure),
    };

    await expect(forgetSession(paths, maintenance, identity)).rejects.toBe(failure);
  });

  test("maps writer contention to the public library-busy failure", async () => {
    const busy = new IndexMaintenanceError("library-busy");
    const maintenance: IndexMaintenance = {
      clear: vi.fn<IndexMaintenance["clear"]>(),
      compact: vi.fn<IndexMaintenance["compact"]>(),
      forget: vi.fn<IndexMaintenance["forget"]>().mockRejectedValue(busy),
    };

    await expect(forgetSession(paths, maintenance, identity)).rejects.toMatchObject({
      code: "library-busy",
      message: "Session library is busy",
      cause: busy,
    });
  });
});
