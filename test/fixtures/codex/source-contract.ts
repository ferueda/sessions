import { createHash } from "node:crypto";
import { appendFileSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { createCodexSource } from "../../../src/adapters/codex/source.ts";
import { MAX_CODEX_ROLLOUT_RECORD_BYTES } from "../../../src/adapters/codex/rollout.ts";
import type {
  DiscoveredSession,
  SessionSource,
  SourceCaptureWorkspace,
} from "../../../src/application/ports/session-source.ts";
import { sameSessionIdentity } from "../../../src/domain/session-identity.ts";
import type { SessionIdentity } from "../../../src/domain/session.ts";
import type {
  ExpectedSourceInput,
  SessionSourceContractFixture,
  SessionSourceContractScenario,
} from "../../contracts/session-source.contract.ts";
import {
  codexRolloutRecords,
  createCodexSourceFixture,
  type CodexFixtureEdge,
  type CodexFixtureThread,
} from "./source.ts";

const PRIMARY_ID = "thread-primary";
const MISSING_METADATA_ID = "thread-missing-metadata";
const PRIMARY_ROLLOUT = `sessions/rollout-2026-${PRIMARY_ID}.jsonl`;
const MISSING_METADATA_ROLLOUT = `sessions/rollout-2026-${MISSING_METADATA_ID}.jsonl`;
const REPEATED_TEXT = "private Codex transcript sentinel";
const PRIVATE_TITLE = "private Codex metadata sentinel";
const MALFORMED_SENTINEL = "private Codex malformed sentinel";

export async function createCodexSessionSourceContractFixture(
  scenario: SessionSourceContractScenario = "ready",
): Promise<SessionSourceContractFixture> {
  const fixture = await createCodexSourceFixture();
  let threads: readonly CodexFixtureThread[] = [
    {
      id: PRIMARY_ID,
      rolloutPath: PRIMARY_ROLLOUT,
      title: PRIVATE_TITLE,
      workspace: "/synthetic/codex-workspace",
      createdAtMs: 1_000,
      updatedAtMs: 2_000,
    },
    { id: MISSING_METADATA_ID, rolloutPath: MISSING_METADATA_ROLLOUT },
  ];
  let edges: readonly CodexFixtureEdge[] = [
    { parentId: "thread-parent", childId: PRIMARY_ID, status: "ready" },
  ];

  await prepareScenario(fixture, scenario, threads, edges);
  const selected = await createCodexSource(fixture.environment);
  const primaryIdentity = identity(selected.instance, PRIMARY_ID);
  const missingMetadataIdentity = identity(selected.instance, MISSING_METADATA_ID);
  const expectedInputs = [
    ...inputsFor(primaryIdentity, PRIMARY_ROLLOUT),
    ...inputsFor(missingMetadataIdentity, MISSING_METADATA_ROLLOUT),
  ];

  let contentReads = 0;
  let reverseDiscovery = false;
  let pendingMutation:
    | { readonly identity: SessionIdentity; readonly inputIndex: number }
    | undefined;
  let mutationSequence = 0;

  const mutate = (targetIdentity: SessionIdentity, inputIndex: number): void => {
    const nativeId = requireFixtureIdentity(targetIdentity, [
      primaryIdentity,
      missingMetadataIdentity,
    ]);
    mutationSequence += 1;
    if (inputIndex === 0) {
      threads = threads.map((thread) =>
        thread.id === nativeId ? { ...thread, title: `changed-title-${mutationSequence}` } : thread,
      );
      fixture.writeState(threads, edges);
      return;
    }
    if (inputIndex === 1) {
      const existing = edges.find((edge) => edge.childId === nativeId);
      edges =
        existing === undefined
          ? [
              ...edges,
              {
                parentId: `changed-parent-${mutationSequence}`,
                childId: nativeId,
                status: "ready",
              },
            ]
          : edges.map((edge) =>
              edge.childId === nativeId
                ? { ...edge, status: `changed-status-${mutationSequence}` }
                : edge,
            );
      fixture.writeState(threads, edges);
      return;
    }
    if (inputIndex === 2) {
      const rollout = nativeId === PRIMARY_ID ? PRIMARY_ROLLOUT : MISSING_METADATA_ROLLOUT;
      appendFileSync(join(fixture.codexHome, rollout), "\n");
      return;
    }
    throw new Error("Codex contract input fixture not found");
  };

  const source: SessionSource = Object.freeze({
    kind: selected.adapter.kind,
    probe: () => selected.adapter.probe(),
    async *discover(workspace: SourceCaptureWorkspace): AsyncIterable<DiscoveredSession> {
      const candidates: DiscoveredSession[] = [];
      for await (const candidate of selected.adapter.discover(workspace)) {
        candidates.push(candidate);
      }
      if (reverseDiscovery) candidates.reverse();
      yield* candidates;
    },
    async read(candidate: DiscoveredSession, workspace: SourceCaptureWorkspace) {
      contentReads += 1;
      // Start the concrete read before the synchronous mutation so live guards
      // and frozen-generation behavior are exercised through the same seam.
      const operation = selected.adapter.read(candidate, workspace);
      const scheduled = pendingMutation;
      pendingMutation = undefined;
      if (scheduled !== undefined) mutate(scheduled.identity, scheduled.inputIndex);
      return operation;
    },
  });

  return {
    source,
    captureWorkspace: fixture.workspace,
    sourceInstance: selected.instance,
    identities: [primaryIdentity, missingMetadataIdentity],
    primaryIdentity,
    missingMetadataIdentity,
    repeatedText: REPEATED_TEXT,
    repeatedTextProvenance: { origin: "human", originConfidence: "high" },
    expectedInputs,
    sensitiveValues: [REPEATED_TEXT, PRIVATE_TITLE, MALFORMED_SENTINEL],
    failureSensitiveValues: [fixture.root],
    snapshotSource: () => snapshotProviderTree(fixture.codexHome),
    contentReadCount: () => contentReads,
    mutateInput: mutate,
    mutateDuringNextRead(targetIdentity, inputIndex) {
      pendingMutation = { identity: targetIdentity, inputIndex };
    },
    reverseDiscoveryOrder() {
      reverseDiscovery = !reverseDiscovery;
    },
    dispose: () => fixture.dispose(),
  };
}

async function prepareScenario(
  fixture: Awaited<ReturnType<typeof createCodexSourceFixture>>,
  scenario: SessionSourceContractScenario,
  threads: readonly CodexFixtureThread[],
  edges: readonly CodexFixtureEdge[],
): Promise<void> {
  if (scenario === "unavailable") return;
  if (scenario === "unreadable") {
    await mkdir(fixture.stateDatabase);
    return;
  }

  fixture.writeState(threads, edges);
  if (scenario === "malformed") {
    await fixture.writeRollout(PRIMARY_ROLLOUT, `{"value":"${MALFORMED_SENTINEL}"\n`);
  } else if (scenario === "unsupported-format") {
    const oversized = Buffer.alloc(MAX_CODEX_ROLLOUT_RECORD_BYTES + 2, 0x61);
    oversized[0] = 0x22;
    oversized[MAX_CODEX_ROLLOUT_RECORD_BYTES] = 0x22;
    oversized[MAX_CODEX_ROLLOUT_RECORD_BYTES + 1] = 0x0a;
    await writeFile(join(fixture.codexHome, PRIMARY_ROLLOUT), oversized);
  } else {
    await fixture.writeRollout(PRIMARY_ROLLOUT, contractRolloutRecords(PRIMARY_ID));
  }
  await fixture.writeRollout(MISSING_METADATA_ROLLOUT, contractRolloutRecords(MISSING_METADATA_ID));
}

function contractRolloutRecords(id: string): readonly unknown[] {
  return [
    ...codexRolloutRecords(id, REPEATED_TEXT),
    {
      timestamp: "2026-07-14T12:00:01.000Z",
      type: "future_contract_record",
      payload: {},
    },
  ];
}

function inputsFor(
  sessionIdentity: SessionIdentity,
  rolloutPath: string,
): readonly ExpectedSourceInput[] {
  const logicalName = rolloutPath.slice(rolloutPath.lastIndexOf("/") + 1);
  return [
    {
      identity: sessionIdentity,
      inputIndex: 0,
      descriptor: {
        role: "thread-row",
        locator: { uri: "codex://state/thread", recordId: sessionIdentity.nativeId },
      },
      ownership: "snapshot-owned",
    },
    {
      identity: sessionIdentity,
      inputIndex: 1,
      descriptor: {
        role: "parent-edge",
        locator: { uri: "codex://state/parent-edge", recordId: sessionIdentity.nativeId },
      },
      ownership: "snapshot-owned",
    },
    {
      identity: sessionIdentity,
      inputIndex: 2,
      descriptor: { role: "rollout", locator: { uri: `codex://rollout/${logicalName}` } },
      ownership: "live",
    },
  ];
}

function identity(source: SessionIdentity["source"], nativeId: string): SessionIdentity {
  return { source, nativeId };
}

function requireFixtureIdentity(
  target: SessionIdentity,
  identities: readonly SessionIdentity[],
): string {
  const match = identities.find((candidate) => sameSessionIdentity(candidate, target));
  if (match === undefined) throw new Error("Codex contract identity fixture not found");
  return match.nativeId;
}

function snapshotProviderTree(root: string): string {
  const entries: unknown[] = [];
  visitProviderTree(root, root, entries);
  return JSON.stringify(entries);
}

function visitProviderTree(root: string, path: string, entries: unknown[]): void {
  const stats = lstatSync(path, { bigint: true });
  const name = relative(root, path) || ".";
  // Source reads may update atime; authoritative content/identity metadata may not change.
  const common = {
    name,
    dev: stats.dev.toString(10),
    ino: stats.ino.toString(10),
    mode: stats.mode.toString(10),
    size: stats.size.toString(10),
    mtimeNs: stats.mtimeNs.toString(10),
    ctimeNs: stats.ctimeNs.toString(10),
    birthtimeNs: stats.birthtimeNs.toString(10),
  };
  if (stats.isDirectory()) {
    entries.push({ ...common, kind: "directory" });
    for (const child of readdirSync(path).sort()) {
      visitProviderTree(root, join(path, child), entries);
    }
    return;
  }
  entries.push({
    ...common,
    kind: stats.isFile() ? "file" : "other",
    ...(stats.isFile()
      ? { digest: createHash("sha256").update(readFileSync(path)).digest("hex") }
      : {}),
  });
}
