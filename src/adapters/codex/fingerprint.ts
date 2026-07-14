import { createHash } from "node:crypto";

export function fingerprintCodexTuple(value: readonly unknown[]): string {
  const digest = createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
  return `sha256-json-v1:${digest}`;
}
