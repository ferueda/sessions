import { describe, expect, test } from "vitest";

import type {
  DiscoveredSession,
  SessionSource,
} from "../../src/application/ports/session-source.ts";
import { readSessionDocument } from "../../src/application/read-session-document.ts";
import { SourceFailureError } from "../../src/application/source-failure.ts";
import { createDiscoveredSession } from "../../src/application/source-input-fingerprint.ts";
import { hashContent } from "../../src/domain/content-hash.ts";
import type { SessionDocument, SessionIdentity } from "../../src/domain/session.ts";

const identity = {
  source: { kind: "synthetic", instanceId: "default" },
  nativeId: "session-1",
} as const;

describe("readSessionDocument", () => {
  test("returns only a fully validated canonical document", async () => {
    const candidate = discoveredSession();

    const document = await readSessionDocument(sourceReturning(validDocument()), candidate);

    expect(document).toEqual(validDocument());
  });

  test("rejects a candidate owned by another adapter before reading", async () => {
    let readCount = 0;
    const source = sourceReturning(validDocument(), {
      kind: "other",
      onRead: () => {
        readCount += 1;
      },
    });

    const error = await captureFailure(readSessionDocument(source, discoveredSession()));

    expect(error.failure).toMatchObject({
      kind: "malformed",
      reason: "candidate-kind-mismatch",
    });
    expect(readCount).toBe(0);
  });

  test("rejects a candidate whose inputs no longer match its aggregate", async () => {
    const candidate = discoveredSession();
    const changed = {
      ...candidate,
      inputs: [{ ...candidate.inputs[0]!, fingerprint: "changed" }],
    };

    const error = await captureFailure(
      readSessionDocument(sourceReturning(validDocument()), changed),
    );

    expect(error.failure.kind).toBe("source-changed");
  });

  test("rejects a valid document with a different identity", async () => {
    const otherIdentity = {
      source: identity.source,
      nativeId: "session-2",
    } as const;

    const error = await captureFailure(
      readSessionDocument(sourceReturning(validDocument(otherIdentity)), discoveredSession()),
    );

    expect(error.failure).toMatchObject({
      kind: "malformed",
      reason: "document-identity-mismatch",
      validation: {
        issues: [{ code: "identity-mismatch", path: "/identity" }],
        truncated: false,
      },
    });
  });

  test("reports invalid documents with bounded issue codes and paths only", async () => {
    const invalid = {
      ...validDocument(),
      "private transcript text": "must not escape",
    } as SessionDocument;

    const error = await captureFailure(
      readSessionDocument(sourceReturning(invalid), discoveredSession()),
    );

    expect(error.failure).toEqual({
      kind: "malformed",
      source: identity.source,
      reason: "invalid-session-document",
      validation: {
        issues: [{ code: "unexpected-property", path: "/" }],
        truncated: false,
      },
    });
    expect(error.message).not.toContain("private transcript text");
    expect(JSON.stringify(error.failure)).not.toContain("private transcript text");
  });

  test("rejects accessor-bearing documents without invoking their getters", async () => {
    const document = { ...validDocument() };
    let getterCalls = 0;
    Object.defineProperty(document, "title", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("private getter payload");
      },
    });

    const error = await captureFailure(
      readSessionDocument(sourceReturning(document), discoveredSession()),
    );

    expect(error.failure).toMatchObject({
      kind: "malformed",
      reason: "invalid-session-document",
      validation: {
        issues: [{ code: "invalid-object", path: "/" }],
        truncated: false,
      },
    });
    expect(getterCalls).toBe(0);
    expect(error.message).not.toContain("private getter payload");
    expect(JSON.stringify(error.failure)).not.toContain("private getter payload");
  });

  test("preserves a typed adapter failure", async () => {
    const expected = new SourceFailureError({
      kind: "unsupported-format",
      source: identity.source,
    });
    const source = sourceReturning(validDocument(), { error: expected });

    const error = await captureFailure(readSessionDocument(source, discoveredSession()));

    expect(error).toBe(expected);
  });

  test("wraps an unexpected adapter error without exposing its raw message", async () => {
    const cause = new Error("secret transcript fragment");
    const source = sourceReturning(validDocument(), { error: cause });

    const error = await captureFailure(readSessionDocument(source, discoveredSession()));

    expect(error.failure).toMatchObject({ kind: "malformed", reason: "adapter-read-failed" });
    expect(error.cause).toBe(cause);
    expect(error.message).not.toContain(cause.message);
  });
});

function discoveredSession(): DiscoveredSession {
  return createDiscoveredSession({
    identity,
    inputs: [
      {
        role: "transcript",
        locator: { uri: "memory:///session-1" },
        fingerprint: "version:1",
      },
    ],
    adapterVersion: "1",
  });
}

function validDocument(documentIdentity: SessionIdentity = identity): SessionDocument {
  return {
    identity: documentIdentity,
    relations: [],
    entries: [
      {
        ordinal: 0,
        kind: "message",
        actor: "human",
        timestamp: "2026-07-13T12:00:00.000Z",
        sourceLocator: { uri: "memory:///session-1#entry-0" },
        content: [
          {
            ordinal: 0,
            text: "hello",
            contentHash: hashContent("hello"),
            origin: "human",
            originConfidence: "high",
            sourceMetadata: {},
          },
        ],
      },
    ],
  };
}

function sourceReturning(
  document: SessionDocument,
  options: {
    readonly kind?: string;
    readonly error?: Error;
    readonly onRead?: () => void;
  } = {},
): SessionSource {
  return {
    kind: options.kind ?? identity.source.kind,
    probe: async () => ({
      source: identity.source,
      status: "ready",
      locations: [{ role: "root", locator: { uri: "memory:///" } }],
      summary: "Synthetic source is ready",
    }),
    async *discover() {
      yield discoveredSession();
    },
    async read() {
      options.onRead?.();
      if (options.error !== undefined) throw options.error;
      return document;
    },
  };
}

async function captureFailure(promise: Promise<SessionDocument>): Promise<SourceFailureError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SourceFailureError) return error;
    throw error;
  }
  throw new Error("Expected SourceFailureError");
}
