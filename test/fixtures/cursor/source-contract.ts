import { writeFile } from "node:fs/promises";

import type {
  DiscoveredSession,
  SessionSource,
  SourceCaptureWorkspace,
} from "../../../src/application/ports/session-source.ts";
import { createCursorSource } from "../../../src/adapters/cursor/source.ts";
import { sameSessionIdentity } from "../../../src/domain/session-identity.ts";
import type { SessionIdentity } from "../../../src/domain/session.ts";
import type {
  ExpectedSourceInput,
  SessionSourceContractFixture,
  SessionSourceContractScenario,
} from "../../contracts/session-source.contract.ts";
import {
  createCursorSourceFixture,
  CURSOR_AGENT_NATIVE_ID,
  CURSOR_CHAT_NATIVE_ID,
  CURSOR_CHAT_TITLE,
  CURSOR_SHARED_TEXT,
  snapshotCursorProviderTree,
} from "./source.ts";

const MALFORMED_SENTINEL = "private Cursor malformed sentinel";

export async function createCursorSessionSourceContractFixture(
  scenario: SessionSourceContractScenario = "ready",
): Promise<SessionSourceContractFixture> {
  const fixture = await createCursorSourceFixture({ ready: false });
  await prepareScenario(fixture, scenario);
  const selected = await createCursorSource(fixture.environment);
  const chatIdentity = identity(selected.instance, CURSOR_CHAT_NATIVE_ID);
  const agentIdentity = identity(selected.instance, CURSOR_AGENT_NATIVE_ID);
  const identities = [chatIdentity, agentIdentity];
  const expectedInputs = [
    ...inputsFor(chatIdentity, "chat-store-v1"),
    ...inputsFor(agentIdentity, "agent-checkpoint-store-v1"),
  ];

  let contentReads = 0;
  let reverseDiscovery = false;
  let mutationSequence = 0;
  let pendingMutation:
    | { readonly identity: SessionIdentity; readonly inputIndex: number }
    | undefined;

  const mutate = (targetIdentity: SessionIdentity, inputIndex: number): void => {
    const nativeId = requireFixtureIdentity(targetIdentity, identities);
    mutationSequence += 1;
    if (nativeId === CURSOR_CHAT_NATIVE_ID) {
      if (inputIndex === 0) {
        fixture.mutateChatMetadata();
        return;
      }
      if (inputIndex === 1) {
        fixture.mutateChatMessage(`Changed Cursor chat ${mutationSequence}`);
        return;
      }
    }
    if (nativeId === CURSOR_AGENT_NATIVE_ID) {
      if (inputIndex === 0) {
        fixture.mutateCatalogRow();
        return;
      }
      if (inputIndex === 1) {
        fixture.mutateAgentMessage(`Changed Cursor agent ${mutationSequence}`);
        return;
      }
    }
    throw new Error("Cursor contract input fixture not found");
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
    identities,
    primaryIdentity: chatIdentity,
    metadataAbsence: {
      identity: agentIdentity,
      fields: ["title", "workspace"],
    },
    expectedProvenance: { origin: "human", originConfidence: "high" },
    repeatedText: CURSOR_SHARED_TEXT,
    repeatedTextProvenance: { origin: "human", originConfidence: "high" },
    expectedInputs,
    sensitiveValues: [CURSOR_SHARED_TEXT, CURSOR_CHAT_TITLE, MALFORMED_SENTINEL],
    failureSensitiveValues: [fixture.root],
    snapshotSource: () => snapshotCursorProviderTree(fixture.cursorHome),
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
  fixture: Awaited<ReturnType<typeof createCursorSourceFixture>>,
  scenario: SessionSourceContractScenario,
): Promise<void> {
  if (scenario === "unavailable") return;
  if (scenario === "unreadable") {
    await writeFile(fixture.cursorHome, "not-a-directory");
    return;
  }

  await fixture.writeReadySource();
  fixture.writeAgentCatalog({ title: null });
  if (scenario === "malformed") {
    fixture.makeChatMessageMalformed();
  } else if (scenario === "unsupported-format") {
    fixture.makeChatStoreUnsupported();
  }
}

function inputsFor(
  sessionIdentity: SessionIdentity,
  family: "chat-store-v1" | "agent-checkpoint-store-v1",
): readonly ExpectedSourceInput[] {
  const base = `cursor://session/${family}/${encodeURIComponent(sessionIdentity.nativeId)}`;
  const firstRole = family === "chat-store-v1" ? "metadata" : "catalog-row";
  return [
    {
      identity: sessionIdentity,
      inputIndex: 0,
      descriptor: { role: firstRole, locator: { uri: `${base}/${firstRole}` } },
      ownership: "snapshot-owned",
    },
    {
      identity: sessionIdentity,
      inputIndex: 1,
      descriptor: { role: "store-main", locator: { uri: `${base}/store-main` } },
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
  if (match === undefined) throw new Error("Cursor contract identity fixture not found");
  return match.nativeId;
}
