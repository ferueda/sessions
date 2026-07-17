import { createHash } from "node:crypto";

import type { SourceInstance } from "../../domain/session.ts";

const INSTANCE_TUPLE_VERSION = "sessions-cursor-source-instance-v1";

export function createCursorSourceInstance(cursorHome: string): SourceInstance {
  const preimage = cursorSourceInstancePreimage(cursorHome);
  const digest = createHash("sha256").update(preimage, "utf8").digest("hex");
  return { kind: "cursor", instanceId: `local-sha256-v1:${digest}` };
}

export function cursorSourceInstancePreimage(cursorHome: string): string {
  assertPath(cursorHome);
  return JSON.stringify([INSTANCE_TUPLE_VERSION, ["cursor-home", cursorHome]]);
}

function assertPath(value: string): void {
  if (value.length === 0 || !value.isWellFormed()) {
    throw new TypeError("Cursor source root must be a non-empty well-formed path");
  }
}
