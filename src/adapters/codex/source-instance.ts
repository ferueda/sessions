import { createHash } from "node:crypto";

import type { SourceInstance } from "../../domain/session.ts";

const INSTANCE_TUPLE_VERSION = "sessions-codex-source-instance-v1";

export function createCodexSourceInstance(codexHome: string, sqliteHome: string): SourceInstance {
  const preimage = codexSourceInstancePreimage(codexHome, sqliteHome);
  const digest = createHash("sha256").update(preimage, "utf8").digest("hex");
  return { kind: "codex", instanceId: `local-sha256-v1:${digest}` };
}

export function codexSourceInstancePreimage(codexHome: string, sqliteHome: string): string {
  assertPath(codexHome);
  assertPath(sqliteHome);
  return JSON.stringify([
    INSTANCE_TUPLE_VERSION,
    ["codex-home", codexHome],
    ["sqlite-home", sqliteHome],
  ]);
}

function assertPath(value: string): void {
  if (value.length === 0 || !value.isWellFormed()) {
    throw new TypeError("Codex source roots must be non-empty well-formed paths");
  }
}
