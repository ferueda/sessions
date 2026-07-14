import { describe, expect, it } from "vitest";

import {
  formatSessionIdentity,
  parseSessionIdentity,
  sameSessionIdentity,
} from "../../src/domain/session-identity.ts";
import type { SessionIdentity } from "../../src/domain/session.ts";

function identity(
  kind = "generic-source",
  instanceId = "local",
  nativeId = "session-1",
): SessionIdentity {
  return { source: { kind, instanceId }, nativeId };
}

describe("session identity codec", () => {
  it("round-trips delimiter characters and Unicode without normalization", () => {
    const original = identity("generic-source", "local:@/%? é", "会話:1@host");
    const printable = formatSessionIdentity(original);

    expect(printable).toBe(
      "generic-source@local%3A%40%2F%25%3F%20%C3%A9:%E4%BC%9A%E8%A9%B1%3A1%40host",
    );

    const parsed = parseSessionIdentity(printable);
    expect(parsed).toEqual({ ok: true, identity: original });
  });

  it("preserves case and canonically distinct Unicode IDs", () => {
    const composed = identity("generic", "Local", "\u00e9");
    const decomposed = identity("generic", "Local", "e\u0301");

    expect(formatSessionIdentity(composed)).not.toBe(formatSessionIdentity(decomposed));
    expect(sameSessionIdentity(composed, decomposed)).toBe(false);
    expect(sameSessionIdentity(composed, identity("generic", "local", "\u00e9"))).toBe(false);
  });

  it("round-trips opaque control characters through percent encoding", () => {
    const original = identity("generic", "local\nprofile", "native\0id\t");
    const printable = formatSessionIdentity(original);

    expect(printable).toBe("generic@local%0Aprofile:native%00id%09");
    expect(parseSessionIdentity(printable)).toEqual({ ok: true, identity: original });
  });

  it.each([
    "generic@instance:%73ession",
    "generic@instance:session%2d1",
    "generic@instance:session%2D1",
    "generic@instance:session!1",
    "generic@instance:session%2f1",
  ])("rejects non-canonical encoding: %s", (value) => {
    expect(parseSessionIdentity(value)).toEqual({
      ok: false,
      code: "non-canonical",
    });
  });

  it.each([
    ["missing-delimiters", "invalid-format"],
    ["generic@:native", "invalid-format"],
    ["generic@instance:", "invalid-format"],
    ["Generic@instance:native", "invalid-kind"],
    ["generic_source@instance:native", "invalid-kind"],
    ["generic@%FF:native", "invalid-encoding"],
    ["generic@instance:%", "invalid-encoding"],
  ])("rejects invalid printable identity %s", (value, code) => {
    expect(parseSessionIdentity(value)).toEqual({ ok: false, code });
  });

  it("rejects invalid identities before formatting", () => {
    expect(() => formatSessionIdentity(identity("Generic"))).toThrow(TypeError);
    expect(() => formatSessionIdentity(identity("generic", "", "native"))).toThrow(TypeError);
    expect(() => formatSessionIdentity(identity("generic", "instance", "\ud800"))).toThrow(
      TypeError,
    );
  });

  it("compares every identity component exactly", () => {
    const original = identity();

    expect(sameSessionIdentity(original, identity())).toBe(true);
    expect(sameSessionIdentity(original, identity("other"))).toBe(false);
    expect(sameSessionIdentity(original, identity("generic-source", "other"))).toBe(false);
    expect(sameSessionIdentity(original, identity("generic-source", "local", "session-2"))).toBe(
      false,
    );
  });
});
