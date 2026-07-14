import { describe, expect, test } from "vitest";

import {
  codexSourceInstancePreimage,
  createCodexSourceInstance,
} from "../../../src/adapters/codex/source-instance.ts";

describe("Codex source instance identity", () => {
  test("locks the canonical POSIX preimage and digest", () => {
    const codexHome = "/home/alice/.codex";
    const preimage =
      '["sessions-codex-source-instance-v1",["codex-home","/home/alice/.codex"],["sqlite-home","/home/alice/.codex"]]';

    expect(codexSourceInstancePreimage(codexHome, codexHome)).toBe(preimage);
    expect(createCodexSourceInstance(codexHome, codexHome)).toEqual({
      kind: "codex",
      instanceId:
        "local-sha256-v1:9a91043ef784ba9f431f57bd649a1991bbefc00d6fba9d266ab5b44268aa7d4e",
    });
  });

  test("is stable while isolating ordered roots and JSON escaping", () => {
    const repeated = createCodexSourceInstance('/tmp/codex "one"', "/tmp/sqlite\\one");

    expect(createCodexSourceInstance('/tmp/codex "one"', "/tmp/sqlite\\one")).toEqual(repeated);
    expect(createCodexSourceInstance("/tmp/sqlite\\one", '/tmp/codex "one"')).not.toEqual(repeated);
    expect(codexSourceInstancePreimage('/tmp/codex "one"', "/tmp/sqlite\\one")).toContain(
      '\\"one\\"',
    );
  });

  test.each(["", "\ud800"])("rejects invalid root %j", (root) => {
    expect(() => createCodexSourceInstance(root, "/tmp/sqlite")).toThrow(TypeError);
    expect(() => createCodexSourceInstance("/tmp/codex", root)).toThrow(TypeError);
  });
});
