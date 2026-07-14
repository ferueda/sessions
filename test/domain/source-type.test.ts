import { describe, expect, test } from "vitest";

import { isCanonicalSourceType, isContentClass } from "../../src/domain/source-type.ts";

describe("canonical source types", () => {
  test.each(["a", "input-image", "a".repeat(64), "0", "a1-b2"])("admits %s", (value) =>
    expect(isCanonicalSourceType(value)).toBe(true),
  );

  test.each([
    "",
    "a".repeat(65),
    "Input-image",
    "input_image",
    " input-image",
    "input-image ",
    "input--image",
    "-input",
    "input-",
    "input/image",
    "input\\image",
    "https://example.invalid/image",
    "data:image/png;base64,private",
    "imagé",
    "image\0private",
  ])("rejects an unsafe token", (value) => expect(isCanonicalSourceType(value)).toBe(false));

  test.each(["image", "resource", "structured", "unknown"])("admits class %s", (value) => {
    expect(isContentClass(value)).toBe(true);
  });
});
