import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, test } from "vitest";

describe("content storage measurement", () => {
  test("sanitizes temporary-directory creation failures", () => {
    const privateTemporaryRoot = path.join(
      process.cwd(),
      "private-measurement-path-that-does-not-exist",
    );
    const result = spawnSync(process.execPath, ["scripts/measure-content-storage.ts"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        TEMP: privateTemporaryRoot,
        TMP: privateTemporaryRoot,
        TMPDIR: privateTemporaryRoot,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Content storage measurement failed: temporary measurement directory could not be created\n",
    );
    expect(result.stderr).not.toContain(privateTemporaryRoot);
  });
});
