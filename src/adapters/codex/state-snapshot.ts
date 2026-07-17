import type { DatabaseSync } from "node:sqlite";

import type { SourceCaptureWorkspace } from "../../application/ports/session-source.ts";
import {
  materializeSqliteSourceSnapshot,
  SqliteSourceSnapshotError,
  type SqliteSourceSnapshotHooks,
} from "../shared/sqlite-source-snapshot.ts";

export type CodexStateSnapshotFailureKind =
  | "malformed"
  | "source-changed"
  | "staging-failed"
  | "unreadable";

export class CodexStateSnapshotError extends Error {
  readonly kind: CodexStateSnapshotFailureKind;

  constructor(kind: CodexStateSnapshotFailureKind) {
    super(snapshotFailureMessage(kind));
    this.name = "CodexStateSnapshotError";
    this.kind = kind;
  }
}

export type CodexStateSnapshotHooks = SqliteSourceSnapshotHooks;

export interface CodexStateSnapshotOptions<T> {
  readonly databasePath: string;
  readonly workspace: SourceCaptureWorkspace;
  readonly materialize: (database: DatabaseSync) => T;
  readonly hooks?: CodexStateSnapshotHooks;
}

export async function materializeCodexStateSnapshot<T>(
  options: CodexStateSnapshotOptions<T>,
): Promise<T> {
  try {
    return await materializeSqliteSourceSnapshot(options);
  } catch (error) {
    if (error instanceof SqliteSourceSnapshotError) {
      throw new CodexStateSnapshotError(error.kind);
    }
    throw error;
  }
}

function snapshotFailureMessage(kind: CodexStateSnapshotFailureKind): string {
  switch (kind) {
    case "malformed":
      return "Codex state data is malformed";
    case "source-changed":
      return "Codex state changed while it was read";
    case "staging-failed":
      return "Codex state staging failed";
    case "unreadable":
      return "Codex state is unreadable";
  }
}
