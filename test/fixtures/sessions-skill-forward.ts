import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { createCodexSourceFixture, type CodexSourceFixture } from "./codex/source.ts";

export const sessionsSkillForwardCases = Object.freeze([
  {
    id: "search-context-transfer",
    route: "search-and-context.md",
    prompt:
      "Prepare the retained retry-policy session from July 15 as local context for another provider.",
    required: [
      "canonical-id",
      "bounded-or-full-export",
      "sensitivity",
      "omissions",
      "untrusted-history",
      "no-provider-delivery",
      "source-unavailable-retained-ready",
    ],
  },
  {
    id: "retrospective",
    route: "retrospective.md",
    prompt:
      "Explain why the retry implementation drifted, how it recovered, and what remained unresolved.",
    required: ["intent", "turning-points", "corrections", "recovery", "hypotheses", "unknowns"],
  },
  {
    id: "preferences",
    route: "preferences.md",
    prompt: "What repeated verification and communication preferences does the user show?",
    required: ["direct-human", "independent-roots", "support-units", "counterexample"],
  },
  {
    id: "workflow-audit",
    route: "workflow-audit.md",
    prompt: "Audit proof-check V1 across the retained tasks and suggest only supported changes.",
    required: [
      "rubric-provenance",
      "eligibility",
      "use-signals",
      "criterion-grades",
      "process-outcome-separation",
      "no-causal-score",
    ],
  },
  {
    id: "verification-audit",
    route: "verification-audit.md",
    prompt: "Were the retry and parser completion claims actually supported by recorded checks?",
    required: ["claim", "contemporaneous-evidence", "later-correction", "historical-not-rerun"],
  },
  {
    id: "handoff-continuity",
    route: "handoff-continuity.md",
    prompt: "What did the retry continuation inherit from its parent, and what did it omit?",
    required: ["exact-relation", "transferred", "omitted", "unknown", "no-inferred-lineage"],
  },
  {
    id: "capability-discovery",
    route: "capability-discovery.md",
    prompt: "What recurring friction might justify a reusable capability?",
    required: ["independent-roots", "tool-friction", "counterexample", "sanitized-evaluation"],
  },
] as const);

export const workflowAuditCoverage = Object.freeze([
  "appropriate-use",
  "missed-use",
  "unnecessary-use",
  "correct-non-use",
  "requested",
  "declared",
  "mention-only",
  "historical-version-unavailable",
  "invocation-unknown",
  "unknown-lineage",
  "followed-process-poor-outcome",
  "unfollowed-process-good-outcome",
  "no-finding-control",
] as const);

export const sessionsSkillForwardExpectedAudit = Object.freeze({
  appropriateUse: "retry-parent",
  missedUse: "missed-good",
  unnecessaryUse: "docs-unnecessary",
  correctNonUse: "docs-correct",
  requestedDeclaredButInvocationUnknown: "unknown-compacted",
  historicalVersionAvailable: ["retry-parent", "docs-unnecessary"],
  historicalVersionUnavailable: "unknown-compacted",
  followedProcessPoorOutcome: "retry-parent",
  partlyUnfollowedGoodOutcome: "missed-good",
  noFindingControl: "docs-correct",
} as const);

export const sessionsSkillForwardCorpusFacts = Object.freeze({
  sessionCount: 6,
  rootCount: 5,
  knownLineageSessionCount: 5,
  unknownLineageSessionCount: 1,
  sharedCorrection:
    "For code changes, show the exact verification command and observed result; do not say only “tests pass”.",
} as const);

export interface SessionsSkillForwardCorpus {
  readonly knownSource: CodexSourceFixture;
  readonly unknownSource: CodexSourceFixture;
  readonly nativeIds: readonly [
    "retry-parent",
    "retry-continuation",
    "missed-good",
    "docs-unnecessary",
    "docs-correct",
    "unknown-compacted",
  ];
  dispose(): Promise<void>;
}

const PROOF_CHECK_V1 = `# proof-check V1

Apply to code changes, not docs-only work.

1. Confirm the requested scope.
2. Inspect the changed files.
3. Run a targeted check.
4. Report the exact command and observed result.

Do not use the network or publish changes.
`;
const PROOF_CHECK_V1_DIGEST = createHash("sha256").update(PROOF_CHECK_V1).digest("hex");
const PROOF_CHECK_V1_RESULT = `path: skills/proof-check/SKILL.md
sha256: ${PROOF_CHECK_V1_DIGEST}
${PROOF_CHECK_V1}`;
const SHARED_CORRECTION = sessionsSkillForwardCorpusFacts.sharedCorrection;

const NATIVE_IDS = [
  "retry-parent",
  "retry-continuation",
  "missed-good",
  "docs-unnecessary",
  "docs-correct",
  "unknown-compacted",
] as const;

const rolloutPaths = Object.freeze({
  retryParent: rolloutPath("09-00-00", NATIVE_IDS[0]),
  retryContinuation: rolloutPath("10-00-00", NATIVE_IDS[1]),
  missedGood: rolloutPath("11-00-00", NATIVE_IDS[2]),
  docsUnnecessary: rolloutPath("12-00-00", NATIVE_IDS[3]),
  docsCorrect: rolloutPath("13-00-00", NATIVE_IDS[4]),
  unknownCompacted: rolloutPath("14-00-00", NATIVE_IDS[5]),
});

/** Build the evaluator-owned generic corpus through the real Codex fixture seam. */
export async function createSessionsSkillForwardCorpus(): Promise<SessionsSkillForwardCorpus> {
  const knownSource = await createCodexSourceFixture();
  let unknownSource: CodexSourceFixture | undefined;

  try {
    unknownSource = await createCodexSourceFixture();
    await Promise.all([
      knownSource.writeRollout(rolloutPaths.retryParent, retryParentRecords()),
      knownSource.writeRollout(rolloutPaths.retryContinuation, retryContinuationRecords()),
      knownSource.writeRollout(rolloutPaths.missedGood, missedGoodRecords()),
      knownSource.writeRollout(rolloutPaths.docsUnnecessary, docsUnnecessaryRecords()),
      knownSource.writeRollout(rolloutPaths.docsCorrect, docsCorrectRecords()),
      unknownSource.writeRollout(rolloutPaths.unknownCompacted, unknownCompactedRecords()),
    ]);

    knownSource.writeState(
      [
        thread(NATIVE_IDS[0], rolloutPaths.retryParent, "Retry policy parser", 9),
        thread(NATIVE_IDS[1], rolloutPaths.retryContinuation, "Retry parser continuation", 10),
        thread(NATIVE_IDS[2], rolloutPaths.missedGood, "Header parser correction", 11),
        thread(NATIVE_IDS[3], rolloutPaths.docsUnnecessary, "Docs-only unnecessary check", 12),
        thread(NATIVE_IDS[4], rolloutPaths.docsCorrect, "Docs-only correct non-use", 13),
      ],
      [{ parentId: NATIVE_IDS[0], childId: NATIVE_IDS[1], status: "completed" }],
    );
    unknownSource.writeState([
      thread(NATIVE_IDS[5], rolloutPaths.unknownCompacted, "Compacted code task", 14),
    ]);
    dropSpawnEdges(unknownSource.stateDatabase);

    const admittedUnknownSource = unknownSource;
    return Object.freeze({
      knownSource,
      unknownSource: admittedUnknownSource,
      nativeIds: NATIVE_IDS,
      async dispose(): Promise<void> {
        await Promise.all([knownSource.dispose(), admittedUnknownSource.dispose()]);
      },
    });
  } catch (error) {
    await Promise.all([knownSource.dispose(), unknownSource?.dispose()]);
    throw error;
  }
}

function retryParentRecords(): readonly unknown[] {
  return [
    sessionMetadata("2026-07-15T09:00:00.000Z", NATIVE_IDS[0]),
    user(
      "2026-07-15T09:00:10.000Z",
      "Use proof-check V1. Implement the retry policy as a token bucket in the parser only. Do not add network work. The completion bar is a targeted parser test and an exact result.",
    ),
    agent(
      "2026-07-15T09:00:20.000Z",
      "I am using proof-check V1 and will confirm the parser-only scope before editing.",
    ),
    toolCall("2026-07-15T09:00:30.000Z", "retry-load-proof-check", "filesystem", "read_file", {
      path: "skills/proof-check/SKILL.md",
    }),
    toolResult("2026-07-15T09:00:31.000Z", "retry-load-proof-check", PROOF_CHECK_V1_RESULT),
    agent(
      "2026-07-15T09:00:40.000Z",
      "Scope confirmed: token-bucket parsing only, no network changes, with a targeted parser check.",
    ),
    agent(
      "2026-07-15T09:01:00.000Z",
      "A shared response cache would make the retry path faster, so I will add one beside the parser.",
    ),
    user(
      "2026-07-15T09:01:10.000Z",
      "That drifts from the request. Remove the cache proposal and return to the parser-only token bucket.",
    ),
    rollback("2026-07-15T09:01:20.000Z"),
    user("2026-07-15T09:01:30.000Z", SHARED_CORRECTION),
    toolCall("2026-07-15T09:01:40.000Z", "retry-inspect", "shell", "exec", {
      command: "git diff -- src/retry-parser.ts test/retry-parser.test.ts",
    }),
    toolResult(
      "2026-07-15T09:01:41.000Z",
      "retry-inspect",
      "Changed files: src/retry-parser.ts, test/retry-parser.test.ts. No network files changed.",
    ),
    toolCall("2026-07-15T09:01:50.000Z", "retry-test", "shell", "exec", {
      command: "pnpm test test/retry-parser.test.ts",
    }),
    toolResult(
      "2026-07-15T09:01:51.000Z",
      "retry-test",
      "PASS test/retry-parser.test.ts — 3 tests passed.",
    ),
    toolCall("2026-07-15T09:02:00.000Z", "retry-review", "shell", "exec", {
      command: "review-scope src/retry-parser.ts test/retry-parser.test.ts",
    }),
    toolResult(
      "2026-07-15T09:02:01.000Z",
      "retry-review",
      "Scope review: parser-only token bucket; no cache, network, or publication changes.",
    ),
    agent(
      "2026-07-15T09:02:10.000Z",
      "Implemented the parser-only token bucket. `pnpm test test/retry-parser.test.ts` passed 3 tests, and the scope review found no network changes.",
    ),
    user(
      "2026-07-15T09:10:00.000Z",
      "The empty Retry-After header still fails. The completion claim was too broad; continue from this task.",
    ),
  ];
}

function retryContinuationRecords(): readonly unknown[] {
  return [
    sessionMetadata(
      "2026-07-15T10:00:00.000Z",
      NATIVE_IDS[1],
      NATIVE_IDS[0],
      "Handoff: keep the token-bucket change parser-only and report the exact verification command and result. Fix the empty Retry-After header regression.",
    ),
    user(
      "2026-07-15T10:00:10.000Z",
      "The handoff omitted the no-network constraint. Restore it before making the fix.",
    ),
    agent(
      "2026-07-15T10:00:20.000Z",
      "Restored: parser-only token bucket, no network changes, and exact verification evidence.",
    ),
    toolCall("2026-07-15T10:00:30.000Z", "continuation-test", "shell", "exec", {
      command: "pnpm test test/retry-parser.test.ts -- --runInBand",
    }),
    toolResult(
      "2026-07-15T10:00:31.000Z",
      "continuation-test",
      "PASS test/retry-parser.test.ts — 4 tests passed, including empty Retry-After.",
    ),
    toolCall("2026-07-15T10:00:40.000Z", "continuation-review", "shell", "exec", {
      command: "review-scope src/retry-parser.ts test/retry-parser.test.ts",
    }),
    toolResult(
      "2026-07-15T10:00:41.000Z",
      "continuation-review",
      "Scope review: parser and parser test only; no network or publication changes.",
    ),
    agent(
      "2026-07-15T10:00:50.000Z",
      "Fixed the empty-header case. `pnpm test test/retry-parser.test.ts -- --runInBand` passed all 4 tests; the review confirmed parser-only scope and no network changes.",
    ),
    user(
      "2026-07-15T10:01:00.000Z",
      "Accepted. The targeted parser regression is covered; broader integration behavior was not reverified here.",
    ),
  ];
}

function missedGoodRecords(): readonly unknown[] {
  return [
    sessionMetadata("2026-07-15T11:00:00.000Z", NATIVE_IDS[2]),
    user(
      "2026-07-15T11:00:10.000Z",
      "Fix comma-separated retry headers in the parser only. Do not add network behavior, and run the focused parser check.",
    ),
    agent(
      "2026-07-15T11:00:20.000Z",
      "I will make the parser-only correction and inspect the focused diff.",
    ),
    user("2026-07-15T11:00:30.000Z", SHARED_CORRECTION),
    toolCall("2026-07-15T11:00:40.000Z", "missed-test", "shell", "exec", {
      command: "pnpm test test/retry-header-list.test.ts",
    }),
    toolResult(
      "2026-07-15T11:00:41.000Z",
      "missed-test",
      "PASS test/retry-header-list.test.ts — 5 tests passed.",
    ),
    agent(
      "2026-07-15T11:00:50.000Z",
      "Fixed comma-separated headers. `pnpm test test/retry-header-list.test.ts` passed 5 tests; no network files changed.",
    ),
    user("2026-07-15T11:01:00.000Z", "Accepted; the parser behavior is correct."),
  ];
}

function docsUnnecessaryRecords(): readonly unknown[] {
  return [
    sessionMetadata("2026-07-15T12:00:00.000Z", NATIVE_IDS[3]),
    user(
      "2026-07-15T12:00:10.000Z",
      "This is a docs-only wording change. proof-check should not apply; update one sentence and do not run code checks.",
    ),
    agent(
      "2026-07-15T12:00:20.000Z",
      "I am using proof-check V1 before editing the documentation.",
    ),
    toolCall("2026-07-15T12:00:30.000Z", "docs-load-proof-check", "filesystem", "read_file", {
      path: "skills/proof-check/SKILL.md",
    }),
    toolResult("2026-07-15T12:00:31.000Z", "docs-load-proof-check", PROOF_CHECK_V1_RESULT),
    user(
      "2026-07-15T12:00:40.000Z",
      "Stop. Loading proof-check was unnecessary and contradicted its docs-only exclusion.",
    ),
    agent(
      "2026-07-15T12:00:50.000Z",
      "Understood. I made only the requested sentence change without code checks.",
    ),
    user("2026-07-15T12:01:00.000Z", "The documentation wording is accepted."),
  ];
}

function docsCorrectRecords(): readonly unknown[] {
  return [
    sessionMetadata("2026-07-15T13:00:00.000Z", NATIVE_IDS[4]),
    user(
      "2026-07-15T13:00:10.000Z",
      "Change the docs sentence to say proof-check applies to code changes. This is docs-only; do not invoke the workflow.",
    ),
    agent("2026-07-15T13:00:20.000Z", "Updated that one sentence and did not run a code workflow."),
    user("2026-07-15T13:00:30.000Z", "Accepted; no further changes are needed."),
  ];
}

function unknownCompactedRecords(): readonly unknown[] {
  return [
    sessionMetadata("2026-07-15T14:00:00.000Z", NATIVE_IDS[5]),
    user(
      "2026-07-15T14:00:10.000Z",
      "Use proof-check for this code change and confirm the exact check before completion.",
    ),
    agent("2026-07-15T14:00:20.000Z", "I am using proof-check for the implementation."),
    encryptedCompaction("2026-07-15T14:00:30.000Z"),
    agent("2026-07-15T14:00:40.000Z", "Implementation complete; tests pass."),
  ];
}

function rolloutPath(time: string, nativeId: string): string {
  return `sessions/2026/07/15/rollout-2026-07-15T${time}-${nativeId}.jsonl`;
}

function thread(id: string, path: string, title: string, hour: number) {
  const createdAtMs = Date.parse(`2026-07-15T${String(hour).padStart(2, "0")}:00:00.000Z`);
  return {
    id,
    rolloutPath: path,
    title,
    workspace: `/workspace/${id}`,
    createdAtMs,
    updatedAtMs: createdAtMs + 15 * 60 * 1_000,
  };
}

function sessionMetadata(
  timestamp: string,
  id: string,
  parentThreadId?: string,
  handoff?: string,
): unknown {
  return {
    timestamp,
    type: "session_meta",
    payload: {
      id,
      ...(parentThreadId === undefined ? {} : { parent_thread_id: parentThreadId }),
      ...(handoff === undefined ? {} : { base_instructions: { text: handoff } }),
    },
  };
}

function user(timestamp: string, message: string): unknown {
  return { timestamp, type: "event_msg", payload: { type: "user_message", message } };
}

function agent(timestamp: string, message: string): unknown {
  return { timestamp, type: "event_msg", payload: { type: "agent_message", message } };
}

function toolCall(
  timestamp: string,
  callId: string,
  namespace: string,
  name: string,
  input: Readonly<Record<string, string>>,
): unknown {
  return {
    timestamp,
    type: "response_item",
    payload: {
      type: "function_call",
      call_id: callId,
      namespace,
      name,
      arguments: JSON.stringify(input),
    },
  };
}

function toolResult(timestamp: string, callId: string, output: string): unknown {
  return {
    timestamp,
    type: "response_item",
    payload: { type: "function_call_output", call_id: callId, output },
  };
}

function rollback(timestamp: string): unknown {
  return {
    timestamp,
    type: "event_msg",
    payload: { type: "thread_rolled_back", num_turns: 1 },
  };
}

function encryptedCompaction(timestamp: string): unknown {
  return {
    timestamp,
    type: "response_item",
    payload: { type: "compaction", encrypted_content: "synthetic-opaque-compaction" },
  };
}

function dropSpawnEdges(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("DROP TABLE thread_spawn_edges");
  } finally {
    database.close();
  }
}
