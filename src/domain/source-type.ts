import { Buffer } from "node:buffer";

export const CONTENT_CLASSES = ["image", "resource", "structured", "unknown"] as const;

export type ContentClass = (typeof CONTENT_CLASSES)[number];

const CONTENT_CLASS_SET: ReadonlySet<string> = new Set(CONTENT_CLASSES);
const SOURCE_TYPE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function isContentClass(value: unknown): value is ContentClass {
  return typeof value === "string" && CONTENT_CLASS_SET.has(value);
}

export function isCanonicalSourceType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.isWellFormed() &&
    Buffer.byteLength(value, "utf8") >= 1 &&
    Buffer.byteLength(value, "utf8") <= 64 &&
    SOURCE_TYPE_PATTERN.test(value)
  );
}
