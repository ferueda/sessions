import {
  createDiscoveredSession,
  fingerprintSourceInputs,
} from "../../src/application/source-input-fingerprint.ts";
import { SourceFailureError, type SourceFailure } from "../../src/application/source-failure.ts";
import type {
  DiscoveredSession,
  SessionSource,
  SourceInputDescriptor,
  SourceProbe,
} from "../../src/application/ports/session-source.ts";
import { hashContent } from "../../src/domain/content-hash.ts";
import { sameSessionIdentity } from "../../src/domain/session-identity.ts";
import type { SessionDocument, SessionIdentity, SourceInstance } from "../../src/domain/session.ts";
import type {
  ExpectedSourceInput,
  SessionSourceContractFixture,
  SessionSourceContractScenario,
} from "../contracts/session-source.contract.ts";

const SENSITIVE_SOURCE_SENTINEL = "private source error sentinel";
const SENSITIVE_METADATA_TITLE = "private metadata sentinel";

interface SyntheticInput {
  readonly role: string;
  readonly locator: SourceInputDescriptor["locator"];
}

interface SyntheticInputState {
  content: string;
}

interface SyntheticInputSnapshot extends SyntheticInput {
  readonly content: string;
}

interface SyntheticSession {
  readonly identity: SessionIdentity;
  readonly inputs: SyntheticInput[];
  readonly timestamp?: string;
}

interface SyntheticSessionSnapshot {
  readonly identity: SessionIdentity;
  readonly inputs: readonly SyntheticInputSnapshot[];
  readonly timestamp?: string;
}

const SOURCE_INSTANCE: SourceInstance = {
  kind: "synthetic-future",
  instanceId: "profile/one",
};
const REPEATED_TEXT = "private transcript sentinel";
const ADAPTER_VERSION = "synthetic-v1";
const inputStates = new WeakMap<SyntheticInput, SyntheticInputState>();

export function createSyntheticSourceFixture(
  scenario: SessionSourceContractScenario = "ready",
): SessionSourceContractFixture {
  const primaryIdentity: SessionIdentity = {
    source: SOURCE_INSTANCE,
    nativeId: "session:primary",
  };
  const missingMetadataIdentity: SessionIdentity = {
    source: SOURCE_INSTANCE,
    nativeId: "session:missing-metadata",
  };
  const sessions: SyntheticSession[] = [
    {
      identity: primaryIdentity,
      timestamp: "2026-07-13T12:00:00.000Z",
      inputs: [
        input("transcript", "primary/transcript", REPEATED_TEXT),
        input("metadata", "primary/metadata", JSON.stringify({ title: SENSITIVE_METADATA_TITLE })),
      ],
    },
    {
      identity: missingMetadataIdentity,
      inputs: [input("transcript", "missing/transcript", REPEATED_TEXT)],
    },
  ];
  const expectedInputs: readonly ExpectedSourceInput[] = sessions.flatMap((session) =>
    session.inputs.map((sourceInput, inputIndex) => ({
      identity: session.identity,
      inputIndex,
      descriptor: {
        role: sourceInput.role,
        locator: copyLocator(sourceInput.locator),
      },
    })),
  );

  let contentReads = 0;
  let reversed = false;
  let duringReadMutation: {
    readonly identity: SessionIdentity;
    readonly inputIndex: number;
  } | null = null;
  const readContent = (sourceInput: SyntheticInput): string => {
    contentReads += 1;
    return inputState(sourceInput).content;
  };

  const source: SessionSource = {
    kind: SOURCE_INSTANCE.kind,
    async probe(): Promise<SourceProbe> {
      return {
        source: SOURCE_INSTANCE,
        status: scenario === "unavailable" || scenario === "unreadable" ? scenario : "ready",
        locations: [
          {
            role: "root",
            locator: { uri: "memory://synthetic/root" },
          },
        ],
        summary: `Synthetic source is ${scenario}`,
      };
    },
    async *discover(): AsyncIterable<DiscoveredSession> {
      if (scenario === "unavailable" || scenario === "unreadable") {
        throw failure(scenario, SOURCE_INSTANCE);
      }

      const ordered = reversed ? [...sessions].reverse() : sessions;
      for (const session of ordered) yield candidateFor(session, readContent);
    },
    async read(candidate: DiscoveredSession): Promise<SessionDocument> {
      if (scenario === "malformed" || scenario === "unsupported-format") {
        throw failure(scenario, SOURCE_INSTANCE);
      }

      const session = sessions.find((item) =>
        sameSessionIdentity(item.identity, candidate.identity),
      );
      if (session === undefined || !candidateMatches(session, candidate, readContent)) {
        throw failure("source-changed", SOURCE_INSTANCE);
      }

      const snapshot = cloneSession(session, readContent);

      if (
        duringReadMutation !== null &&
        sameSessionIdentity(duringReadMutation.identity, session.identity)
      ) {
        mutate(session, duringReadMutation.inputIndex);
        duringReadMutation = null;
      }

      const document = documentFor(snapshot);
      if (!candidateMatches(session, candidate, readContent)) {
        throw failure("source-changed", SOURCE_INSTANCE);
      }
      return document;
    },
  };

  return {
    source,
    sourceInstance: SOURCE_INSTANCE,
    identities: [primaryIdentity, missingMetadataIdentity],
    primaryIdentity,
    missingMetadataIdentity,
    repeatedText: REPEATED_TEXT,
    expectedInputs,
    sensitiveValues: [REPEATED_TEXT, SENSITIVE_METADATA_TITLE, SENSITIVE_SOURCE_SENTINEL],
    snapshotSource: () => snapshotSessions(sessions),
    contentReadCount: () => contentReads,
    mutateInput(identity, inputIndex) {
      const session = requireSession(sessions, identity);
      mutate(session, inputIndex);
    },
    mutateDuringNextRead(identity, inputIndex) {
      duringReadMutation = { identity, inputIndex };
    },
    reverseDiscoveryOrder() {
      reversed = !reversed;
    },
    async dispose(): Promise<void> {},
  };
}

function input(role: string, recordId: string, content: string): SyntheticInput {
  const sourceInput: SyntheticInput = {
    role,
    locator: { uri: "memory://synthetic/session", recordId },
  };
  inputStates.set(sourceInput, { content });
  return sourceInput;
}

function candidateFor(
  session: SyntheticSession,
  readContent: (sourceInput: SyntheticInput) => string,
): DiscoveredSession {
  return createDiscoveredSession({
    identity: session.identity,
    inputs: descriptorsFor(session, readContent),
    adapterVersion: ADAPTER_VERSION,
  });
}

function descriptorsFor(
  session: SyntheticSession,
  readContent: (sourceInput: SyntheticInput) => string,
): readonly SourceInputDescriptor[] {
  return session.inputs.map((item) => {
    const contentHash = hashContent(readContent(item));
    return {
      role: item.role,
      locator: item.locator,
      fingerprint: `${contentHash.scheme}:${contentHash.digest}`,
    };
  });
}

function candidateMatches(
  session: SyntheticSession,
  candidate: DiscoveredSession,
  readContent: (sourceInput: SyntheticInput) => string,
): boolean {
  const current = fingerprintSourceInputs(descriptorsFor(session, readContent));
  return (
    sameSessionIdentity(session.identity, candidate.identity) &&
    current.scheme === candidate.aggregateFingerprint.scheme &&
    current.digest === candidate.aggregateFingerprint.digest
  );
}

function cloneSession(
  session: SyntheticSession,
  readContent: (sourceInput: SyntheticInput) => string,
): SyntheticSessionSnapshot {
  return {
    identity: session.identity,
    ...(session.timestamp === undefined ? {} : { timestamp: session.timestamp }),
    inputs: session.inputs.map((item) => ({
      role: item.role,
      locator:
        item.locator.recordId === undefined
          ? { uri: item.locator.uri }
          : { uri: item.locator.uri, recordId: item.locator.recordId },
      content: readContent(item),
    })),
  };
}

function documentFor(session: SyntheticSessionSnapshot): SessionDocument {
  const transcript = session.inputs.find((item) => item.role === "transcript");
  if (transcript === undefined) throw new Error("Synthetic transcript fixture is missing");
  const metadata = session.inputs.find((item) => item.role === "metadata");
  const title = metadata === undefined ? undefined : parseTitle(metadata.content);
  const contentHash = hashContent(transcript.content);

  return {
    identity: session.identity,
    ...(title === undefined ? {} : { title }),
    ...(session.timestamp === undefined
      ? {}
      : { createdAt: session.timestamp, updatedAt: session.timestamp }),
    relations: [],
    entries: [
      {
        ordinal: 0,
        kind: "message",
        actor: "human",
        ...(session.timestamp === undefined ? {} : { timestamp: session.timestamp }),
        sourceLocator: transcript.locator,
        content: [
          {
            ordinal: 0,
            text: transcript.content,
            contentHash,
            origin: "unknown",
            originConfidence: "unknown",
            sourceMetadata: { fixture: "synthetic" },
          },
        ],
      },
    ],
  };
}

function parseTitle(content: string): string | undefined {
  const value: unknown = JSON.parse(content);
  if (
    typeof value === "object" &&
    value !== null &&
    "title" in value &&
    typeof value.title === "string"
  ) {
    return value.title;
  }
  return undefined;
}

function requireSession(
  sessions: readonly SyntheticSession[],
  identity: SessionIdentity,
): SyntheticSession {
  const session = sessions.find((item) => sameSessionIdentity(item.identity, identity));
  if (session === undefined) throw new Error("Synthetic session fixture not found");
  return session;
}

function mutate(session: SyntheticSession, inputIndex: number): void {
  const target = session.inputs[inputIndex];
  if (target === undefined) throw new Error("Synthetic input fixture not found");
  inputState(target).content += "!";
}

function snapshotSessions(sessions: readonly SyntheticSession[]): string {
  return JSON.stringify(
    sessions.map((session) => ({
      identity: session.identity,
      ...(session.timestamp === undefined ? {} : { timestamp: session.timestamp }),
      inputs: session.inputs.map((sourceInput) => ({
        role: sourceInput.role,
        locator: copyLocator(sourceInput.locator),
        content: inputState(sourceInput).content,
      })),
    })),
  );
}

function inputState(sourceInput: SyntheticInput): SyntheticInputState {
  const state = inputStates.get(sourceInput);
  if (state === undefined) throw new Error("Synthetic input state not found");
  return state;
}

function copyLocator(locator: SourceInputDescriptor["locator"]): SourceInputDescriptor["locator"] {
  return locator.recordId === undefined
    ? { uri: locator.uri }
    : { uri: locator.uri, recordId: locator.recordId };
}

function failure(kind: SourceFailure["kind"], source: SourceInstance): SourceFailureError {
  return new SourceFailureError({ kind, source }, { cause: new Error(SENSITIVE_SOURCE_SENTINEL) });
}
