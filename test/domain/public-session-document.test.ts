import { describe, expect, it } from "vitest";

import { hashContent } from "../../src/domain/content-hash.ts";
import {
  PUBLIC_SESSION_DOCUMENT_SCHEMA,
  SESSION_DOCUMENT_DIGEST_SCHEME,
  digestPublicSessionDocument,
  isSessionDocumentDigest,
  projectPublicSessionDocument,
  sameSessionDocumentDigest,
  type PublicSessionDocumentV1,
} from "../../src/domain/public-session-document.ts";
import type { SessionDocument } from "../../src/domain/session.ts";
import { createTestDocument } from "../fixtures/session.ts";

const PRIVATE_MARKER = "private-fixture-marker";

function createDocument(overrides: Partial<SessionDocument> = {}): SessionDocument {
  const firstText = "Generic human request";
  const secondText = "Generic model response";
  return {
    identity: {
      source: { kind: `synthetic-${PRIVATE_MARKER}`, instanceId: `instance-${PRIVATE_MARKER}` },
      nativeId: `native-${PRIVATE_MARKER}`,
    },
    title: "Generic session",
    workspace: `/workspace/${PRIVATE_MARKER}`,
    createdAt: "2026-07-15T10:00:00.000Z",
    updatedAt: "2026-07-15T10:01:00.000Z",
    lineageCoverage: "complete",
    relations: [
      {
        kind: "parent",
        target: {
          source: { kind: "synthetic-provider", instanceId: "profile-one" },
          nativeId: "parent-session",
        },
        confidence: "high",
      },
    ],
    entries: [
      {
        ordinal: 0,
        kind: "message",
        actor: "human",
        timestamp: "2026-07-15T10:00:00.000Z",
        sourceLocator: { uri: `memory://${PRIVATE_MARKER}/human` },
        content: [
          {
            ordinal: 0,
            kind: "text",
            origin: "human",
            originConfidence: "high",
            text: firstText,
            contentHash: hashContent(firstText),
            sourceMetadata: { private: PRIVATE_MARKER },
          },
          {
            ordinal: 1,
            kind: "omitted",
            origin: "injected",
            originConfidence: "medium",
            contentClass: "resource",
            sourceType: "generic-resource",
            sourceMetadata: { private: PRIVATE_MARKER },
          },
        ],
      },
      {
        ordinal: 1,
        kind: "tool-call",
        actor: "tool",
        timestamp: "2026-07-15T10:01:00.000Z",
        relatedEntryOrdinal: 0,
        toolCallId: "call-one",
        toolName: "read",
        toolNamespace: "generic",
        sourceLocator: { uri: `memory://${PRIVATE_MARKER}/tool` },
        content: [
          {
            ordinal: 0,
            kind: "text",
            origin: "tool",
            originConfidence: "high",
            text: secondText,
            contentHash: hashContent(secondText),
            sourceMetadata: { private: PRIVATE_MARKER },
          },
        ],
      },
    ],
    ...overrides,
  };
}

function digest(document: SessionDocument) {
  return digestPublicSessionDocument(projectPublicSessionDocument(document));
}

describe("public session document", () => {
  it("locks the versioned public-document digest", () => {
    expect(digest(createTestDocument())).toEqual({
      scheme: SESSION_DOCUMENT_DIGEST_SCHEME,
      digest: "98bc268e8cb56073a59ccdc3c29dfdfd708810ffb439d64f5f82c89949640162",
    });
  });

  it("constructs the exact frozen allowlist", () => {
    const projection = projectPublicSessionDocument(createDocument());

    expect(projection.documentSchema).toBe(PUBLIC_SESSION_DOCUMENT_SCHEMA);
    expect(projection.relations[0]).toEqual({
      ordinal: 0,
      kind: "parent",
      target: {
        source: { kind: "synthetic-provider", instanceId: "profile-one" },
        nativeId: "parent-session",
      },
      confidence: "high",
    });
    expect(projection.entries[0]?.content.map((segment) => segment.ordinal)).toEqual([0, 1]);
    expect(JSON.stringify(projection)).not.toContain(PRIVATE_MARKER);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.relations)).toBe(true);
    expect(Object.isFrozen(projection.relations[0]?.target.source)).toBe(true);
    expect(Object.isFrozen(projection.entries[0]?.content)).toBe(true);
    expect(Object.isFrozen(projection.entries[0]?.content[0])).toBe(true);
  });

  it("omits absent optional fields instead of substituting null", () => {
    const base = createDocument();
    const document: SessionDocument = {
      identity: base.identity,
      lineageCoverage: base.lineageCoverage,
      relations: base.relations,
      entries: [
        {
          ordinal: 0,
          kind: "message",
          actor: "model",
          sourceLocator: { uri: "memory://generic/entry" },
          content: [],
        },
      ],
    };

    expect(projectPublicSessionDocument(document)).toEqual({
      documentSchema: PUBLIC_SESSION_DOCUMENT_SCHEMA,
      lineageCoverage: "complete",
      relations: [
        {
          ordinal: 0,
          kind: "parent",
          target: {
            source: { kind: "synthetic-provider", instanceId: "profile-one" },
            nativeId: "parent-session",
          },
          confidence: "high",
        },
      ],
      entries: [{ ordinal: 0, kind: "message", actor: "model", content: [] }],
    });
  });

  it("keeps root identity and private canonical metadata outside the digest", () => {
    const original = createDocument();
    const changedPrivateFields = createDocument({
      identity: {
        source: { kind: "another-provider", instanceId: "another-profile" },
        nativeId: "another-session",
      },
      workspace: "/another/private/workspace",
    });
    const changedLocatorsAndMetadata = createDocument({
      entries: original.entries.map((entry) => ({
        ...entry,
        sourceLocator: { uri: "memory://other-private-locator" },
        content: entry.content.map((segment) => ({
          ...segment,
          sourceMetadata: { other: "private-value" },
        })),
      })),
    });

    expect(digest(original)).toEqual(digest(changedPrivateFields));
    expect(digest(original)).toEqual(digest(changedLocatorsAndMetadata));
  });

  it("makes relation targets and canonical array order digest-sensitive", () => {
    const original = createDocument();
    const changedTarget = createDocument({
      relations: [
        {
          ...original.relations[0]!,
          target: {
            source: { kind: "synthetic-provider", instanceId: "profile-two" },
            nativeId: "another-parent",
          },
        },
      ],
    });
    const secondRelation = {
      kind: "fork" as const,
      target: {
        source: { kind: "synthetic-provider", instanceId: "profile-three" },
        nativeId: "fork-session",
      },
      confidence: "medium" as const,
    };
    const relations = [original.relations[0]!, secondRelation];
    const reorderedRelations = createDocument({ relations: [...relations].reverse() });

    expect(digest(original)).not.toEqual(digest(changedTarget));
    expect(digest(createDocument({ relations }))).not.toEqual(digest(reorderedRelations));
  });

  it("makes entry and content array order digest-sensitive", () => {
    const original = createDocument();
    const firstEntry = original.entries[0]!;
    const textSegment = firstEntry.content[0]!;
    const omittedSegment = firstEntry.content[1]!;
    const orderedContent = createDocument({
      entries: [
        {
          ...firstEntry,
          content: [
            { ...textSegment, ordinal: 0 },
            { ...omittedSegment, ordinal: 1 },
          ],
        },
      ],
    });
    const reversedContent = createDocument({
      entries: [
        {
          ...firstEntry,
          content: [
            { ...omittedSegment, ordinal: 0 },
            { ...textSegment, ordinal: 1 },
          ],
        },
      ],
    });
    const entries = [
      { ...firstEntry, ordinal: 0, content: [] },
      {
        ...firstEntry,
        ordinal: 1,
        kind: "reply",
        actor: "model" as const,
        timestamp: "2026-07-15T10:00:01.000Z",
        sourceLocator: { uri: "memory://generic/reply" },
        content: [],
      },
    ];
    const reorderedEntries = createDocument({
      entries: [
        { ...entries[1]!, ordinal: 0 },
        { ...entries[0]!, ordinal: 1 },
      ],
    });

    expect(digest(orderedContent)).not.toEqual(digest(reversedContent));
    expect(digest(createDocument({ entries }))).not.toEqual(digest(reorderedEntries));
  });

  it("hashes every eligible scalar field and exact Unicode", () => {
    const original = createDocument();
    const firstEntry = original.entries[0]!;
    const textSegment = firstEntry.content[0]!;
    const omittedSegment = firstEntry.content[1]!;
    if (textSegment.kind !== "text" || omittedSegment.kind !== "omitted") {
      throw new Error("expected mixed public content fixture");
    }
    const changedText = "Changed generic human request";
    const variants: SessionDocument[] = [
      createDocument({ title: "Changed title" }),
      createDocument({ createdAt: "2026-07-15T09:59:00.000Z" }),
      createDocument({ updatedAt: "2026-07-15T10:02:00.000Z" }),
      createDocument({ lineageCoverage: "unknown" }),
      createDocument({ relations: [{ ...original.relations[0]!, kind: "fork" }] }),
      createDocument({ relations: [{ ...original.relations[0]!, confidence: "low" }] }),
      createDocument({
        relations: [
          {
            ...original.relations[0]!,
            target: {
              ...original.relations[0]!.target,
              source: { ...original.relations[0]!.target.source, kind: "other-provider" },
            },
          },
        ],
      }),
      createDocument({
        relations: [
          {
            ...original.relations[0]!,
            target: {
              ...original.relations[0]!.target,
              source: { ...original.relations[0]!.target.source, instanceId: "profile-other" },
            },
          },
        ],
      }),
      createDocument({
        relations: [
          {
            ...original.relations[0]!,
            target: {
              ...original.relations[0]!.target,
              nativeId: "other-parent",
            },
          },
        ],
      }),
      createDocument({ entries: [{ ...original.entries[0]!, ordinal: 7 }, original.entries[1]!] }),
      createDocument({
        entries: [{ ...original.entries[0]!, kind: "event" }, original.entries[1]!],
      }),
      createDocument({
        entries: [{ ...original.entries[0]!, actor: "system" }, original.entries[1]!],
      }),
      createDocument({
        entries: [
          { ...original.entries[0]!, timestamp: "2026-07-15T10:00:01.000Z" },
          original.entries[1]!,
        ],
      }),
      createDocument({
        entries: [original.entries[0]!, { ...original.entries[1]!, relatedEntryOrdinal: 1 }],
      }),
      createDocument({
        entries: [original.entries[0]!, { ...original.entries[1]!, toolCallId: "call-two" }],
      }),
      createDocument({
        entries: [original.entries[0]!, { ...original.entries[1]!, toolName: "write" }],
      }),
      createDocument({
        entries: [original.entries[0]!, { ...original.entries[1]!, toolNamespace: "other" }],
      }),
      createDocument({
        entries: [
          {
            ...firstEntry,
            content: [{ ...textSegment, origin: "injected" }, omittedSegment],
          },
          original.entries[1]!,
        ],
      }),
      createDocument({
        entries: [
          {
            ...firstEntry,
            content: [{ ...textSegment, originConfidence: "low" }, omittedSegment],
          },
          original.entries[1]!,
        ],
      }),
      createDocument({
        entries: [
          {
            ...firstEntry,
            content: [
              { ...textSegment, text: changedText, contentHash: hashContent(changedText) },
              omittedSegment,
            ],
          },
          original.entries[1]!,
        ],
      }),
      createDocument({
        entries: [
          {
            ...firstEntry,
            content: [textSegment, { ...omittedSegment, contentClass: "image" }],
          },
          original.entries[1]!,
        ],
      }),
      createDocument({
        entries: [
          {
            ...firstEntry,
            content: [textSegment, { ...omittedSegment, sourceType: "other-resource" }],
          },
          original.entries[1]!,
        ],
      }),
    ];

    for (const variant of variants) expect(digest(variant)).not.toEqual(digest(original));

    const composed = createDocument({ title: "é" });
    const decomposed = createDocument({ title: "e\u0301" });
    expect(projectPublicSessionDocument(composed).title).toBe("é");
    expect(digest(composed)).not.toEqual(digest(decomposed));
  });

  it("recognizes and compares only strict digest values", () => {
    const value = digest(createDocument());

    expect(value.scheme).toBe(SESSION_DOCUMENT_DIGEST_SCHEME);
    expect(value.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(value)).toBe(true);
    expect(isSessionDocumentDigest(value)).toBe(true);
    expect(isSessionDocumentDigest({ ...value, extra: true })).toBe(false);
    expect(isSessionDocumentDigest({ ...value, digest: value.digest.toUpperCase() })).toBe(false);
    expect(isSessionDocumentDigest({ ...value, scheme: "sha256" })).toBe(false);
    expect(sameSessionDocumentDigest(value, { ...value })).toBe(true);
    expect(sameSessionDocumentDigest(value, { ...value, digest: "0".repeat(64) })).toBe(false);
  });

  it("hashes a large public document through the fragment writer", () => {
    const original = createDocument();
    const entry = original.entries[0]!;
    const segment = entry.content[0]!;
    if (segment.kind !== "text") throw new Error("expected text fixture");
    const text = "generic large evidence ".repeat(131_072);
    const document = createDocument({
      entries: [
        {
          ...entry,
          content: [{ ...segment, text, contentHash: hashContent(text) }],
        },
      ],
    });

    expect(digest(document)).toEqual({
      scheme: SESSION_DOCUMENT_DIGEST_SCHEME,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it("rejects unknown values passed through the public type", () => {
    const projection = projectPublicSessionDocument(createDocument());
    const unsupported = {
      ...projection,
      workspace: "/private/workspace",
    } as unknown as PublicSessionDocumentV1;
    const invalid = { ...projection, extra: undefined } as unknown as PublicSessionDocumentV1;

    expect(() => digestPublicSessionDocument(unsupported)).toThrow(TypeError);
    expect(() => digestPublicSessionDocument(invalid)).toThrow(TypeError);
  });
});
