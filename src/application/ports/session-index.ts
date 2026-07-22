import type {
  SessionObservation,
  SessionRevision,
  ValidatedSessionReplacement,
} from "../validate-session.ts";
import type { SessionQuerySummary } from "../../domain/session-query.ts";
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
  readonly missing: number;
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
      readonly outcome: "missing";
    };

export type IndexRunResult =
  | {
      readonly source: SourceInstance;
      readonly status: "completed";
      readonly startedAt: string;
      readonly finishedAt: string;
      readonly counts: IndexRunCounts;
      readonly coverage: { readonly status: "complete"; readonly observedAt: string };
      readonly items: readonly IndexRunItem[];
      readonly omittedItemCount: number;
    }
  | {
      readonly source: SourceInstance;
      readonly status: "incomplete";
      readonly startedAt: string;
      readonly finishedAt: string;
      readonly counts: IndexRunCounts;
      readonly coverage: { readonly status: "unknown"; readonly observedAt: string };
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
    };

export type IndexedSessionSummary = SessionQuerySummary;

export interface IndexedSession {
  readonly summary: IndexedSessionSummary;
  readonly document: SessionDocument;
}

export interface StartIndexRunInput {
  readonly source: SourceInstance;
  readonly startedAt: string;
}

export const SESSION_INDEX_BATCH_LIMIT = 128;

export interface TrackedIdentityPage {
  readonly identities: readonly SessionIdentity[];
  readonly hasMore: boolean;
}

export interface SessionIndexReader {
  getFreshness(identity: SessionIdentity): Promise<SessionFreshness>;
  getSummary(identity: SessionIdentity): Promise<IndexedSessionSummary | undefined>;
  getDocument(identity: SessionIdentity): Promise<SessionDocument | undefined>;
  getSession(identity: SessionIdentity): Promise<IndexedSession | undefined>;
}

export interface SessionIndexWriter extends SessionIndexReader {
  startRun(input: StartIndexRunInput): Promise<SessionIndexRun>;
  getFreshnessBatch(
    run: SessionIndexRun,
    identities: readonly SessionIdentity[],
  ): Promise<readonly SessionFreshness[]>;
  recordUnchangedBatch(
    run: SessionIndexRun,
    observations: readonly SessionObservation[],
  ): Promise<void>;
  recordFailure(
    run: SessionIndexRun,
    observation: SessionObservation,
    failure: RecordableSessionFailureCode,
  ): Promise<void>;
  replaceSession(run: SessionIndexRun, replacement: ValidatedSessionReplacement): Promise<void>;
  listTrackedIdentitiesPage(
    run: SessionIndexRun,
    afterNativeId?: string,
  ): Promise<TrackedIdentityPage>;
  recordMissingBatch(run: SessionIndexRun, identities: readonly SessionIdentity[]): Promise<void>;
  finishRun(run: SessionIndexRun, completion: FinishIndexRunInput): Promise<IndexRunResult>;
}

export function createSessionIndexRunId(value: unknown): SessionIndexRunId {
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()) {
    throw new TypeError("Session index run ID must be a non-empty well-formed string");
  }
  return value as SessionIndexRunId;
}
