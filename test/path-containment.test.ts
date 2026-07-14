import path from "node:path";

import { describe, expect, it } from "vitest";

import { isPathWithin } from "../scripts/path-containment.ts";

describe("path containment", () => {
  it("rejects a Windows candidate on a different drive", () => {
    expect(
      isPathWithin(
        "D:\\a\\sessions\\sessions",
        "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\sessions-package\\sessions.js",
        path.win32,
      ),
    ).toBe(false);
  });

  it("accepts a Windows descendant on the same drive", () => {
    expect(
      isPathWithin(
        "D:\\a\\sessions\\sessions",
        "D:\\a\\sessions\\sessions\\dist\\bin\\sessions.js",
        path.win32,
      ),
    ).toBe(true);
  });

  it("rejects a sibling path", () => {
    expect(isPathWithin("/workspace/sessions", "/workspace/sessions-copy", path.posix)).toBe(false);
  });
});
