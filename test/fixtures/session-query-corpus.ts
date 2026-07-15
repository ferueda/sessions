import { hashContent } from "../../src/domain/content-hash.ts";
import type {
  Actor,
  ContentOrigin,
  SessionDocument,
  SessionEntry,
  SessionIdentity,
  SourceInstance,
} from "../../src/domain/session.ts";

export const SESSION_QUERY_CORPUS_SOURCE: SourceInstance = Object.freeze({
  kind: "synthetic",
  instanceId: "query-profile",
});

export const SESSION_QUERY_CONTRACT_TIMES = Object.freeze({
  present: "2026-07-14T10:00:00.000Z",
  missing: "2026-07-14T11:00:00.000Z",
  unknown: "2026-07-14T12:00:00.000Z",
  pageable: "2026-07-14T13:00:00.000Z",
});

export interface SessionQueryContractCorpus {
  readonly present: SessionDocument;
  readonly missing: SessionDocument;
  readonly unknown: SessionDocument;
  readonly pageable: readonly SessionDocument[];
  readonly ranking: SessionQueryRankingCorpus;
  readonly documents: readonly SessionDocument[];
}

export interface SessionQueryRankingCorpus {
  readonly bm25Better: SessionDocument;
  readonly bm25Worse: SessionDocument;
  readonly activityOrder: readonly SessionDocument[];
  readonly binaryOrder: readonly SessionDocument[];
  readonly singleOccurrence: SessionDocument;
  readonly repeatedOccurrence: SessionDocument;
  readonly documents: readonly SessionDocument[];
}

export function sessionQueryCorpusIdentity(nativeId: string): SessionIdentity {
  return { source: SESSION_QUERY_CORPUS_SOURCE, nativeId };
}

/** Compact corpus retained by focused evidence/context tests. */
export function sessionQueryCorpusDocuments(): readonly [SessionDocument, SessionDocument] {
  const first = sessionQueryCorpusIdentity("a-session");
  const second = sessionQueryCorpusIdentity("b-session");
  const shared = textSegment(0, "shared recurrence evidence");
  return [
    document(first, {
      lineageCoverage: "complete",
      title: "Alpha query session",
      workspace: "/workspace/alpha",
      createdAt: "2026-07-14T11:00:00.000Z",
      updatedAt: "2026-07-14T12:00:00.000Z",
      entries: [
        entry(0, "alpha intervening beta start evidence"),
        entry(1, "invoke recurrence OR /tmp/Project/File.ts", {
          kind: "tool-call",
          actor: "model",
          relatedEntryOrdinal: 4,
          toolCallId: "call-1",
          toolName: "exec_command",
          toolNamespace: "functions",
          origin: "model",
        }),
        entry(2, `neighbor ${"é".repeat(600)}`),
        entry(3, "lifecycle recurrence", {
          kind: "turn-start",
          actor: "system",
          relatedEntryOrdinal: 1,
          origin: "system",
        }),
        entry(4, "linked recurrence result", {
          kind: "tool-result",
          actor: "tool",
          relatedEntryOrdinal: 1,
          toolCallId: "call-1",
          origin: "tool",
        }),
        entry(5, "shared recurrence evidence"),
        entry(6, `${"prefix ".repeat(140)}MAGIC_LATE_MATCH final evidence`),
        entry(7, "before\u0001\u0002CONTROL_MATCH after"),
        entry(8, `${"x".repeat(1_000)} GIANT_SUFFIX_MATCH`),
        entry(9, `GIANT_PREFIX_MATCH ${"x".repeat(1_000)}`),
        entry(10, `${"LATE ".repeat(30)}${"x".repeat(1_000)} AMBIGUOUS_LATE_MATCH`),
      ],
    }),
    document(second, {
      lineageCoverage: "unknown",
      title: "Beta query session",
      workspace: "/workspace/beta",
      createdAt: "2026-07-14T11:00:00.000Z",
      updatedAt: "2026-07-14T12:00:00.000Z",
      entries: [
        {
          ...entry(0, "unused", { timestamp: false }),
          content: [shared, { ...shared, ordinal: 1 }],
        },
      ],
    }),
  ];
}

/** Provider-neutral acceptance corpus for every retained-library query backend. */
export function sessionQueryContractCorpus(): SessionQueryContractCorpus {
  const presentIdentity = identity(
    { kind: "synthetic-query", instanceId: "profile/primary:α" },
    "session/opaque:α@1",
  );
  const missingIdentity = identity(
    { kind: "synthetic-query", instanceId: "profile/missing" },
    "gone:session@1",
  );
  const unknownIdentity = identity(
    { kind: "future-provider", instanceId: "profile:unknown@α" },
    "unknown/session:1",
  );

  const present = document(presentIdentity, {
    lineageCoverage: "complete",
    title: "Unicode naïve query session",
    workspace: "/workspace/Primary",
    createdAt: "2026-07-14T09:00:00.000Z",
    updatedAt: "2026-07-14T09:30:00.000Z",
    entries: [
      entry(0, 'filterable unicode naïve "quoted phrase" opaque abc:123@v1', {
        timestamp: "2026-07-14T09:10:00.000Z",
      }),
      entry(1, "filterable model analysis", {
        kind: "analysis-note",
        actor: "model",
        origin: "model",
        timestamp: "2026-07-14T09:20:00.000Z",
      }),
      entry(2, "filterable toolfilter observed invocation", {
        kind: "tool-call",
        actor: "model",
        origin: "model",
        timestamp: "2026-07-14T09:30:00.000Z",
        toolCallId: "tool-call-1",
        toolName: "read_file",
        toolNamespace: "filesystem",
      }),
      entry(3, "toolfilter read_file appears only in user text", {
        timestamp: "2026-07-14T09:40:00.000Z",
      }),
      entry(4, "toolfilter read_file appears in injected context", {
        actor: "system",
        origin: "injected",
        timestamp: "2026-07-14T09:50:00.000Z",
      }),
      entry(5, "timeless-filterable evidence", { timestamp: false }),
    ],
  });
  const missing = document(missingIdentity, {
    lineageCoverage: "complete",
    title: "Retained missing provider session",
    workspace: "/workspace/Missing",
    entries: [
      entry(0, "retained-disappearance filterable evidence", {
        timestamp: "2026-07-14T10:20:00.000Z",
      }),
    ],
  });
  const unknown = document(unknownIdentity, {
    lineageCoverage: "unknown",
    title: "Unknown coverage session",
    workspace: "/workspace/Unknown",
    createdAt: "2026-07-14T09:00:00.000Z",
    updatedAt: "2026-07-14T09:05:00.000Z",
    entries: [entry(0, "unknown-observation evidence", { timestamp: false })],
  });
  const pageable = Array.from({ length: 23 }, (_, ordinal) => {
    const padded = String(ordinal).padStart(2, "0");
    const session = identity(
      { kind: "synthetic-query", instanceId: "profile/pageable" },
      `page/session:${padded}@v1`,
    );
    return document(session, {
      lineageCoverage: "complete",
      title: `Pageable session ${padded}`,
      workspace: "/workspace/Pageable",
      createdAt: `2026-07-13T${String(ordinal).padStart(2, "0")}:00:00.000Z`,
      entries: [entry(0, `pageable corpus evidence ${padded}`)],
    });
  });
  const ranking = sessionQueryRankingCorpus();
  return {
    present,
    missing,
    unknown,
    pageable,
    ranking,
    documents: [present, missing, unknown, ...pageable, ...ranking.documents],
  };
}

function sessionQueryRankingCorpus(): SessionQueryRankingCorpus {
  const bm25Source = { kind: "synthetic-rank", instanceId: "bm25" };
  const bm25Better = document(identity(bm25Source, "better-older"), {
    lineageCoverage: "complete",
    createdAt: "2026-07-10T00:00:00.000Z",
    entries: [entry(0, "bm25rank bm25rank bm25rank bm25rank")],
  });
  const bm25Worse = document(identity(bm25Source, "worse-newer"), {
    lineageCoverage: "complete",
    updatedAt: "2026-07-14T23:00:00.000Z",
    entries: [entry(0, `bm25rank ${"background ".repeat(200)}`)],
  });

  const activitySource = { kind: "synthetic-rank", instanceId: "activity" };
  const activityOrder = [
    document(identity(activitySource, "updated-newest"), {
      lineageCoverage: "complete",
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-14T16:00:00.000Z",
      entries: [entry(0, "activityrank")],
    }),
    document(identity(activitySource, "created-fallback"), {
      lineageCoverage: "complete",
      createdAt: "2026-07-14T15:00:00.000Z",
      entries: [entry(0, "activityrank")],
    }),
    document(identity(activitySource, "updated-older"), {
      lineageCoverage: "complete",
      createdAt: "2026-07-14T14:00:00.000Z",
      updatedAt: "2026-07-14T14:30:00.000Z",
      entries: [entry(0, "activityrank")],
    }),
    document(identity(activitySource, "activity-unknown"), {
      lineageCoverage: "complete",
      entries: [entry(0, "activityrank")],
    }),
  ];

  const binaryOrder = [
    rankingTieDocument({ kind: "rank-a", instanceId: "same" }, "same"),
    rankingTieDocument({ kind: "rank-b", instanceId: "A" }, "same"),
    rankingTieDocument({ kind: "rank-b", instanceId: "a" }, "A"),
    rankingTieDocument({ kind: "rank-b", instanceId: "a" }, "a", 2),
  ];

  const occurrenceSource = { kind: "synthetic-rank", instanceId: "occurrence" };
  const occurrenceText = "occurrencerank";
  const singleOccurrence = document(identity(occurrenceSource, "a-single"), {
    lineageCoverage: "complete",
    createdAt: "2026-07-14T12:00:00.000Z",
    entries: [entry(0, occurrenceText)],
  });
  const repeatedEntry = entry(0, occurrenceText);
  const repeatedOccurrence = document(identity(occurrenceSource, "z-repeated"), {
    lineageCoverage: "complete",
    createdAt: "2026-07-14T12:00:00.000Z",
    entries: [
      {
        ...repeatedEntry,
        content: Array.from({ length: 5 }, (_, ordinal) => textSegment(ordinal, occurrenceText)),
      },
    ],
  });

  return {
    bm25Better,
    bm25Worse,
    activityOrder,
    binaryOrder,
    singleOccurrence,
    repeatedOccurrence,
    documents: [
      bm25Better,
      bm25Worse,
      ...activityOrder,
      ...binaryOrder,
      singleOccurrence,
      repeatedOccurrence,
    ],
  };
}

function rankingTieDocument(
  source: SourceInstance,
  nativeId: string,
  entryCount = 1,
): SessionDocument {
  return document(identity(source, nativeId), {
    lineageCoverage: "complete",
    entries: Array.from({ length: entryCount }, (_, ordinal) => entry(ordinal, "binaryrank")),
  });
}

function identity(source: SourceInstance, nativeId: string): SessionIdentity {
  return { source, nativeId };
}

function document(
  identityValue: SessionIdentity,
  options: {
    readonly lineageCoverage: SessionDocument["lineageCoverage"];
    readonly title?: string;
    readonly workspace?: string;
    readonly createdAt?: string;
    readonly updatedAt?: string;
    readonly entries: readonly SessionEntry[];
  },
): SessionDocument {
  return {
    identity: identityValue,
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
    ...(options.updatedAt === undefined ? {} : { updatedAt: options.updatedAt }),
    lineageCoverage: options.lineageCoverage,
    relations: [],
    entries: options.entries,
  };
}

function entry(
  ordinal: number,
  text: string,
  options: {
    readonly kind?: string;
    readonly actor?: Actor;
    readonly relatedEntryOrdinal?: number;
    readonly toolCallId?: string;
    readonly toolName?: string;
    readonly toolNamespace?: string;
    readonly origin?: ContentOrigin;
    readonly timestamp?: string | false;
  } = {},
): SessionEntry {
  const defaultTimestamp = `2026-07-14T12:00:${String(Math.min(ordinal, 59)).padStart(2, "0")}.000Z`;
  return {
    ordinal,
    kind: options.kind ?? "message",
    actor: options.actor ?? "human",
    ...(options.timestamp === false ? {} : { timestamp: options.timestamp ?? defaultTimestamp }),
    ...(options.relatedEntryOrdinal === undefined
      ? {}
      : { relatedEntryOrdinal: options.relatedEntryOrdinal }),
    ...(options.toolCallId === undefined ? {} : { toolCallId: options.toolCallId }),
    ...(options.toolName === undefined ? {} : { toolName: options.toolName }),
    ...(options.toolNamespace === undefined ? {} : { toolNamespace: options.toolNamespace }),
    sourceLocator: { uri: `memory://query/${String(ordinal)}` },
    content: [textSegment(0, text, options.origin)],
  };
}

function textSegment(ordinal: number, text: string, origin: ContentOrigin = "human") {
  return {
    kind: "text" as const,
    ordinal,
    text,
    contentHash: hashContent(text),
    origin,
    originConfidence: "high" as const,
    sourceMetadata: {},
  };
}
