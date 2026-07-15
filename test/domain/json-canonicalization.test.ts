import { describe, expect, it } from "vitest";

import { writeCanonicalJson } from "../../src/domain/json-canonicalization.ts";

function canonicalize(value: unknown): string {
  const fragments: string[] = [];
  writeCanonicalJson(value, (fragment) => fragments.push(fragment));
  return fragments.join("");
}

describe("canonical JSON", () => {
  it("matches the relevant RFC 8785 scalar serialization", () => {
    const value = {
      numbers: [Number("333333333.33333329"), 4.5, 2e-3, 1e-27],
      string: '€$\u000f\nA\'B"\\\\"/',
      literals: [null, true, false],
    };

    expect(canonicalize(value)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it("sorts object names by UTF-16 code units", () => {
    const value = {
      "€": "Euro",
      "\r": "Carriage Return",
      דּ: "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      ö: "Latin Small Letter O With Diaeresis",
    };

    expect(canonicalize(value)).toBe(
      '{"\\r":"Carriage Return","1":"One","":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it("ignores object insertion order but preserves array order", () => {
    expect(canonicalize({ z: 1, a: 2 })).toBe(canonicalize({ a: 2, z: 1 }));
    expect(canonicalize(["first", "second"])).not.toBe(canonicalize(["second", "first"]));
  });

  it("preserves exact well-formed Unicode without normalization", () => {
    expect(canonicalize("\u00e9")).toBe('"é"');
    expect(canonicalize("\u00e9")).not.toBe(canonicalize("e\u0301"));
    expect(canonicalize("\u2028\u2029")).toBe('"  "');
  });

  it.each([
    ["not finite", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ["undefined", undefined],
    ["bigint", 1n],
    ["symbol", Symbol("unsupported")],
    ["function", () => undefined],
    ["non-plain object", new Date(0)],
    ["sparse array", Array(1)],
  ])("rejects %s", (_name, value) => {
    expect(() => canonicalize(value)).toThrow(TypeError);
  });

  it("rejects ill-formed strings and keys", () => {
    expect(() => canonicalize("before\ud800after")).toThrow(TypeError);
    expect(() => canonicalize({ ["\udfff"]: true })).toThrow(TypeError);
  });

  it("rejects unsupported nested values and cycles instead of omitting them", () => {
    expect(() => canonicalize({ nested: undefined })).toThrow(TypeError);

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalize(cyclic)).toThrow(TypeError);
  });

  it("streams a large value as fragments", () => {
    const text = "generic evidence ".repeat(131_072);
    let fragments = 0;
    let utf8Bytes = 0;

    writeCanonicalJson({ entries: [{ text }] }, (fragment) => {
      fragments += 1;
      utf8Bytes += Buffer.byteLength(fragment, "utf8");
    });

    expect(fragments).toBeGreaterThan(10);
    expect(utf8Bytes).toBeGreaterThan(Buffer.byteLength(text, "utf8"));
  });
});
