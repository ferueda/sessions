import type {
  SessionObservation,
  SessionRevision,
  ValidatedSessionReplacement,
} from "../validate-session.ts";
import type { SessionDocument, SessionIdentity, SourceInstance } from "../../domain/session.ts";

declare const sessionIndexRunIdBrand: unique symbol;

export type SessionIndexRunId = string & {
  readonly [sessionIndexRunIdBrand]: "SessionIndexRunId";
};

export type SessionIndexFailureCode =
  | "unavailable"
  | "unreadable"
  | "malformed"
  | "source-changed"
  | "unsupported-format"
  | "repository-write";

export type RecordableSessionFailureCode = Exclude<SessionIndexFailureCode, "repository-write">;

export type IndexRunFailureCode =
  | "source-unavailable"
  | "source-unreadable"
  | "probe-failed"
  | "discovery-failed"
  | "interrupted"
  | "repository-write";

export interface SessionIndexRun {
  readonly id: SessionIndexRunId;
  readonly source: SourceInstance;
  readonly startedAt: string;
}

export interface IndexRunCounts {
  readonly discovered: number;
  readonly unchanged: number;
  readonly updated: number;
  readonly failed: number;
  readonly removed: number;
  readonly stale: number;
}

export type FinishIndexRunInput =
  | {
      readonly status: "completed";
      readonly finishedAt: string;
    }
  | {
      readonly status: "incomplete";
      readonly finishedAt: string;
      readonly failure: IndexRunFailureCode;
    };

export type IndexRunItem =
  | {
      readonly identity: SessionIdentity;
      readonly outcome: "failed";
      readonly failure: SessionIndexFailureCode;
    }
  | {
      readonly identity: SessionIdentity;
      readonly outcome: "removed";
    };

export type IndexRunResult =
  | {
      readonly source: SourceInstance;
      readonly status: "completed";
      readonly startedAt: string;
      readonly finishedAt: string;
      readonly counts: IndexRunCounts;
      readonly items: readonly IndexRunItem[];
      readonly omittedItemCount: number;
    }
  | {
      readonly source: SourceInstance;
      readonly status: "incomplete";
      readonly startedAt: string;
      readonly finishedAt: string;
      readonly counts: IndexRunCounts;
      readonly items: readonly IndexRunItem[];
      readonly omittedItemCount: number;
      readonly failure: IndexRunFailureCode;
    };

export interface IndexedLatestObservation {
  readonly outcome: "indexed";
  readonly revision: SessionRevision;
}

export interface UnchangedLatestObservation {
  readonly outcome: "unchanged";
  readonly revision: SessionRevision;
}

export interface FailedLatestObservation {
  readonly outcome: "failed";
  readonly revision: SessionRevision;
  readonly failure: SessionIndexFailureCode;
}

export interface RemovedLatestObservation {
  readonly outcome: "removed";
}

export type SessionFreshness =
  | {
      readonly status: "untracked";
      readonly identity: SessionIdentity;
    }
  | {
      readonly status: "unindexed";
      readonly identity: SessionIdentity;
      readonly latest: FailedLatestObservation;
    }
  | {
      readonly status: "current";
      readonly identity: SessionIdentity;
      readonly lastGood: SessionRevision;
      readonly latest: IndexedLatestObservation | UnchangedLatestObservation;
    }
  | {
      readonly status: "stale";
      readonly identity: SessionIdentity;
      readonly lastGood: SessionRevision;
      readonly latest: FailedLatestObservation;
    }
  | {
      readonly status: "removed";
      readonly identity: SessionIdentity;
      readonly latest: RemovedLatestObservation;
    };

export interface IndexedSessionSummary {
  readonly identity: SessionIdentity;
  readonly title?: string;
  readonly workspace?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly freshness: "current" | "stale";
}

export interface StartIndexRunInput {
  readonly source: SourceInstance;
  readonly startedAt: string;
}

export interface SessionIndexReader {
  getFreshness(identity: SessionIdentity): Promise<SessionFreshness>;
  getSummary(identity: SessionIdentity): Promise<IndexedSessionSummary | undefined>;
  getDocument(identity: SessionIdentity): Promise<SessionDocument | undefined>;
}

export interface SessionIndexWriter extends SessionIndexReader {
  listIndexedIdentities(source: SourceInstance): Promise<readonly SessionIdentity[]>;
  startRun(input: StartIndexRunInput): Promise<SessionIndexRun>;
  recordUnchanged(run: SessionIndexRun, observation: SessionObservation): Promise<void>;
  recordFailure(
    run: SessionIndexRun,
    observation: SessionObservation,
    failure: RecordableSessionFailureCode,
  ): Promise<void>;
  replaceSession(run: SessionIndexRun, replacement: ValidatedSessionReplacement): Promise<void>;
  removeSession(run: SessionIndexRun, identity: SessionIdentity): Promise<void>;
  finishRun(run: SessionIndexRun, completion: FinishIndexRunInput): Promise<IndexRunResult>;
}

export function createSessionIndexRunId(value: unknown): SessionIndexRunId {
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()) {
    throw new TypeError("Session index run ID must be a non-empty well-formed string");
  }
  return value as SessionIndexRunId;
}
