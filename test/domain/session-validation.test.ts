import { describe, expect, test } from "vitest";

import { hashContent } from "../../src/domain/content-hash.ts";
import type {
  SessionDocument,
  SessionEntry,
  SessionIdentity,
  SessionRelation,
  TextContentSegment,
} from "../../src/domain/session.ts";
import {
  MAX_SESSION_VALIDATION_ISSUES,
  validateSessionDocument,
} from "../../src/domain/session-validation.ts";

describe("validateSessionDocument", () => {
  test("returns a canonical document without filling absent optional values", () => {
    const document = validDocument();

    const result = validateSessionDocument(document);

    expect(result).toEqual({ ok: true, document });
    if (!result.ok) throw new Error("expected a valid document");
    expect(result.document).not.toHaveProperty("title");
    expect(result.document.entries[0]).not.toHaveProperty("toolCallId");
  });

  test("preserves unknown provenance without actor inference or timestamp ordering", () => {
    const document = validDocument();
    const entry = document.entries[0]!;
    const segment = entry.content[0]!;
    if (segment.kind !== "text") throw new Error("expected text segment");
    const value = {
      ...document,
      createdAt: "2026-07-13T12:00:00.000Z",
      updatedAt: "2026-07-13T11:00:00.000Z",
      entries: [
        {
          ...entry,
          actor: "human",
          timestamp: "2026-07-13T10:00:00.000Z",
          content: [
            {
              ...segment,
              origin: "unknown",
              originConfidence: "unknown",
            },
          ],
        },
        canonicalEntry(1, "2026-07-13T09:00:00.000Z"),
      ],
    };

    const result = validateSessionDocument(value);

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("expected a valid document");
    expect(result.document.entries[0]?.content[0]).toMatchObject({
      origin: "unknown",
      originConfidence: "unknown",
    });
  });

  test("rejects unexpected properties without returning their names or values", () => {
    const value = { ...validDocument(), privateToken: "do-not-report" };

    const result = invalidResult(value);

    expect(result.issues).toContainEqual({ code: "unexpected-property", path: "/" });
    expect(JSON.stringify(result)).not.toContain("privateToken");
    expect(JSON.stringify(result)).not.toContain("do-not-report");
  });

  test("rejects accessor properties without invoking adapter-controlled code", () => {
    const document = { ...validDocument() };
    let getterCalls = 0;
    Object.defineProperty(document, "title", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("private getter payload");
      },
    });

    const result = invalidResult(document);

    expect(result.issues).toEqual([{ code: "invalid-object", path: "/" }]);
    expect(getterCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain("private getter payload");
  });

  test("rejects accessor array elements without invoking adapter-controlled code", () => {
    const entries: unknown[] = [];
    let getterCalls = 0;
    Object.defineProperty(entries, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("private array getter payload");
      },
    });

    const result = invalidResult({ ...validDocument(), entries });

    expect(result.issues).toEqual([{ code: "invalid-object", path: "/entries" }]);
    expect(getterCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain("private array getter payload");
  });

  test("reports a missing required property once at its canonical path", () => {
    const document = validDocument();

    const result = invalidResult({
      lineageCoverage: document.lineageCoverage,
      relations: document.relations,
      entries: document.entries,
    });

    expect(result.issues).toEqual([{ code: "missing-property", path: "/identity" }]);
  });

  test("requires explicit canonical lineage coverage", () => {
    const document = validDocument();
    const { lineageCoverage: _, ...missing } = document;

    expect(invalidResult(missing).issues).toContainEqual({
      code: "missing-property",
      path: "/lineageCoverage",
    });
    expect(invalidResult({ ...document, lineageCoverage: "partial" }).issues).toContainEqual({
      code: "invalid-literal",
      path: "/lineageCoverage",
    });
  });

  test("rejects noncanonical identities and an unexpected valid identity", () => {
    const document = validDocument();
    const invalidIdentity = {
      ...document,
      identity: { source: { kind: "Synthetic", instanceId: "local" }, nativeId: "one" },
    };

    expect(invalidResult(invalidIdentity).issues).toContainEqual({
      code: "invalid-identity",
      path: "/identity",
    });
    expect(
      invalidResult(document, {
        expectedIdentity: identity("another-session"),
      }).issues,
    ).toContainEqual({ code: "identity-mismatch", path: "/identity" });
  });

  test("requires literal actor, origin, confidence, and relation values", () => {
    const document = validDocument();
    const entry = document.entries[0]!;
    const segment = entry.content[0]!;
    const relation = document.relations[0]!;
    const value = {
      ...document,
      relations: [{ ...relation, kind: "copy", confidence: "certain" }],
      entries: [
        {
          ...entry,
          actor: "assistant",
          content: [{ ...segment, origin: "prompt", originConfidence: "certain" }],
        },
      ],
    };

    expect(invalidResult(value).issues).toEqual(
      expect.arrayContaining([
        { code: "invalid-literal", path: "/relations/0/kind" },
        { code: "invalid-literal", path: "/relations/0/confidence" },
        { code: "invalid-literal", path: "/entries/0/actor" },
        { code: "invalid-literal", path: "/entries/0/content/0/origin" },
        { code: "invalid-literal", path: "/entries/0/content/0/originConfidence" },
      ]),
    );
  });

  test("requires zero-based contiguous entry and segment ordinals in array order", () => {
    const document = validDocument();
    const entry = document.entries[0]!;
    const segment = entry.content[0]!;
    const value = {
      ...document,
      entries: [{ ...entry, ordinal: 1, content: [{ ...segment, ordinal: 2 }] }],
    };

    expect(invalidResult(value).issues).toEqual(
      expect.arrayContaining([
        { code: "noncontiguous-ordinal", path: "/entries/0/ordinal" },
        { code: "noncontiguous-ordinal", path: "/entries/0/content/0/ordinal" },
      ]),
    );
  });

  test("rejects nonexistent and self entry references", () => {
    const document = validDocument();
    const first = document.entries[0]!;
    const second = canonicalEntry(1);

    expect(
      invalidResult({ ...document, entries: [{ ...first, relatedEntryOrdinal: 4 }] }).issues,
    ).toContainEqual({
      code: "invalid-entry-reference",
      path: "/entries/0/relatedEntryOrdinal",
    });
    expect(
      invalidResult({ ...document, entries: [first, { ...second, relatedEntryOrdinal: 1 }] })
        .issues,
    ).toContainEqual({
      code: "self-entry-reference",
      path: "/entries/1/relatedEntryOrdinal",
    });
  });

  test("rejects self and duplicate session relations", () => {
    const document = validDocument();
    const relation = document.relations[0]!;

    expect(
      invalidResult({
        ...document,
        relations: [{ ...relation, target: document.identity }],
      }).issues,
    ).toContainEqual({ code: "self-relation", path: "/relations/0" });
    expect(invalidResult({ ...document, relations: [relation, relation] }).issues).toContainEqual({
      code: "duplicate-relation",
      path: "/relations/1",
    });
  });

  test("recomputes exact text hashes and rejects malformed hash shapes", () => {
    const document = validDocument();
    const entry = document.entries[0]!;
    const segment = entry.content[0]!;
    if (segment.kind !== "text") throw new Error("expected text segment");

    expect(
      invalidResult({
        ...document,
        entries: [{ ...entry, content: [{ ...segment, text: `${segment.text}\n` }] }],
      }).issues,
    ).toContainEqual({
      code: "content-hash-mismatch",
      path: "/entries/0/content/0/contentHash",
    });
    expect(
      invalidResult({
        ...document,
        entries: [{ ...entry, content: [{ ...segment, contentHash: "not-a-hash" }] }],
      }).issues,
    ).toContainEqual({
      code: "invalid-content-hash",
      path: "/entries/0/content/0/contentHash",
    });
  });

  test("rejects ill-formed Unicode content before hashing", () => {
    const document = validDocument();
    const entry = document.entries[0]!;
    const segment = entry.content[0]!;
    const result = invalidResult({
      ...document,
      entries: [{ ...entry, content: [{ ...segment, text: "\ud800" }] }],
    });

    expect(result.issues).toContainEqual({
      code: "invalid-text",
      path: "/entries/0/content/0/text",
    });
    expect(result.issues).not.toContainEqual(
      expect.objectContaining({ code: "content-hash-mismatch" }),
    );
  });

  test.each(illFormedPersistedStringCases())(
    "rejects ill-formed Unicode in persisted $label",
    ({ value, issue }) => {
      const result = invalidResult(value);

      expect(result.issues).toContainEqual(issue);
      expect(JSON.stringify(result)).not.toContain("private");
    },
  );

  test("preserves well-formed Unicode exactly without normalization", () => {
    const decomposed = "Cafe\u0301";
    const document = validDocument();
    const entry = document.entries[0]!;
    const segment = canonicalSegment(0, decomposed);

    const result = validateSessionDocument({
      ...document,
      title: decomposed,
      entries: [
        {
          ...entry,
          kind: decomposed,
          content: [
            {
              ...segment,
              sourceMetadata: { [decomposed]: decomposed },
            },
          ],
        },
      ],
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("expected well-formed Unicode");
    expect(result.document.title).toBe(decomposed);
    expect(result.document.entries[0]?.kind).toBe(decomposed);
    const admittedSegment = result.document.entries[0]?.content[0];
    expect(admittedSegment?.kind).toBe("text");
    expect(admittedSegment?.kind === "text" ? admittedSegment.text : undefined).toBe(decomposed);
    expect(result.document.entries[0]?.content[0]?.sourceMetadata).toEqual({
      [decomposed]: decomposed,
    });
    expect(decomposed).not.toBe(decomposed.normalize("NFC"));
  });

  test.each([
    "2026-07-13T12:00:00Z",
    "2026-07-13T12:00:00.00Z",
    "2026-07-13T12:00:00.000+00:00",
    "2026-02-30T12:00:00.000Z",
  ])("rejects noncanonical timestamp %s", (createdAt) => {
    expect(invalidResult({ ...validDocument(), createdAt }).issues).toContainEqual({
      code: "invalid-timestamp",
      path: "/createdAt",
    });
  });

  test("rejects optional properties explicitly set to undefined", () => {
    expect(invalidResult({ ...validDocument(), title: undefined }).issues).toContainEqual({
      code: "expected-string",
      path: "/title",
    });
  });

  test("preserves mixed text and omitted evidence in exact order", () => {
    const document = validDocument();
    const entry = document.entries[0]!;
    const result = validateSessionDocument({
      ...document,
      entries: [
        {
          ...entry,
          content: [
            canonicalSegment(0, "before"),
            {
              kind: "omitted",
              ordinal: 1,
              contentClass: "image",
              sourceType: "input-image",
              origin: "human",
              originConfidence: "high",
              sourceMetadata: {},
            },
            canonicalSegment(2, "after"),
          ],
        },
      ],
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("expected mixed evidence");
    expect(result.document.entries[0]?.content.map(({ kind }) => kind)).toEqual([
      "text",
      "omitted",
      "text",
    ]);
  });

  test("rejects unsafe omitted types and cross-variant fields", () => {
    const document = validDocument();
    const entry = document.entries[0]!;
    const omitted = {
      kind: "omitted",
      ordinal: 0,
      contentClass: "unknown",
      sourceType: "unknown-record",
      origin: "unknown",
      originConfidence: "unknown",
      sourceMetadata: {},
    };
    expect(
      invalidResult({
        ...document,
        entries: [{ ...entry, content: [{ ...omitted, sourceType: "unsafe_type" }] }],
      }).issues,
    ).toContainEqual({ code: "invalid-source-type", path: "/entries/0/content/0/sourceType" });
    expect(
      invalidResult({
        ...document,
        entries: [{ ...entry, content: [{ ...omitted, text: "private" }] }],
      }).issues,
    ).toContainEqual({ code: "invalid-segment-variant", path: "/entries/0/content/0" });
  });

  test("admits legacy call IDs but scopes tool name and namespace to calls", () => {
    const document = validDocument();
    const entry = document.entries[0]!;
    expect(
      validateSessionDocument({
        ...document,
        entries: [{ ...entry, toolCallId: "legacy-id" }],
      }),
    ).toMatchObject({ ok: true });
    expect(
      invalidResult({ ...document, entries: [{ ...entry, toolName: "shell" }] }).issues,
    ).toContainEqual({ code: "invalid-tool-identity", path: "/entries/0" });
    expect(
      invalidResult({
        ...document,
        entries: [{ ...entry, kind: "tool-call", toolNamespace: "local" }],
      }).issues,
    ).toContainEqual({
      code: "invalid-tool-identity",
      path: "/entries/0/toolNamespace",
    });
  });

  test("bounds diagnostics at 32 safe issues", () => {
    const entries = Array.from({ length: 40 }, (_, ordinal) => ({
      ...canonicalEntry(ordinal),
      actor: "not-an-actor",
    }));

    const result = invalidResult({ ...validDocument(), entries });

    expect(result.issues).toHaveLength(MAX_SESSION_VALIDATION_ISSUES);
    expect(result.truncated).toBe(true);
    expect(result.issues.every(({ code }) => code === "invalid-literal")).toBe(true);
  });
});

function illFormedPersistedStringCases(): readonly {
  readonly label: string;
  readonly value: unknown;
  readonly issue: { readonly code: string; readonly path: string };
}[] {
  const invalid = "private\ud800value";
  const entryDocument = validDocument();
  const entry = entryDocument.entries[0]!;
  const segment = entry.content[0]!;
  if (segment.kind !== "text") throw new Error("expected text segment");
  const relation = entryDocument.relations[0]!;
  const withEntry = (overrides: Readonly<Record<string, unknown>>): unknown => ({
    ...entryDocument,
    entries: [{ ...entry, ...overrides }],
  });
  const withSegment = (overrides: Readonly<Record<string, unknown>>): unknown =>
    withEntry({ content: [{ ...segment, ...overrides }] });

  return [
    {
      label: "source kind",
      value: {
        ...validDocument(),
        identity: {
          ...validDocument().identity,
          source: { ...validDocument().identity.source, kind: invalid },
        },
      },
      issue: { code: "invalid-string", path: "/identity/source/kind" },
    },
    {
      label: "source instance ID",
      value: {
        ...validDocument(),
        identity: {
          ...validDocument().identity,
          source: { ...validDocument().identity.source, instanceId: invalid },
        },
      },
      issue: { code: "invalid-string", path: "/identity/source/instanceId" },
    },
    {
      label: "native session ID",
      value: { ...validDocument(), identity: { ...validDocument().identity, nativeId: invalid } },
      issue: { code: "invalid-string", path: "/identity/nativeId" },
    },
    {
      label: "title",
      value: { ...validDocument(), title: invalid },
      issue: { code: "invalid-string", path: "/title" },
    },
    {
      label: "workspace",
      value: { ...validDocument(), workspace: invalid },
      issue: { code: "invalid-string", path: "/workspace" },
    },
    {
      label: "created timestamp",
      value: { ...validDocument(), createdAt: invalid },
      issue: { code: "invalid-string", path: "/createdAt" },
    },
    {
      label: "updated timestamp",
      value: { ...validDocument(), updatedAt: invalid },
      issue: { code: "invalid-string", path: "/updatedAt" },
    },
    {
      label: "relation target identity",
      value: {
        ...entryDocument,
        relations: [{ ...relation, target: { ...relation.target, nativeId: invalid } }],
      },
      issue: { code: "invalid-string", path: "/relations/0/target/nativeId" },
    },
    {
      label: "relation kind",
      value: { ...entryDocument, relations: [{ ...relation, kind: invalid }] },
      issue: { code: "invalid-literal", path: "/relations/0/kind" },
    },
    {
      label: "relation confidence",
      value: { ...entryDocument, relations: [{ ...relation, confidence: invalid }] },
      issue: { code: "invalid-literal", path: "/relations/0/confidence" },
    },
    {
      label: "entry kind",
      value: withEntry({ kind: invalid }),
      issue: { code: "invalid-string", path: "/entries/0/kind" },
    },
    {
      label: "entry actor",
      value: withEntry({ actor: invalid }),
      issue: { code: "invalid-literal", path: "/entries/0/actor" },
    },
    {
      label: "entry timestamp",
      value: withEntry({ timestamp: invalid }),
      issue: { code: "invalid-string", path: "/entries/0/timestamp" },
    },
    {
      label: "tool call ID",
      value: withEntry({ toolCallId: invalid }),
      issue: { code: "invalid-string", path: "/entries/0/toolCallId" },
    },
    {
      label: "source locator URI",
      value: withEntry({ sourceLocator: { ...entry.sourceLocator, uri: invalid } }),
      issue: { code: "invalid-string", path: "/entries/0/sourceLocator/uri" },
    },
    {
      label: "source locator record ID",
      value: withEntry({ sourceLocator: { ...entry.sourceLocator, recordId: invalid } }),
      issue: { code: "invalid-string", path: "/entries/0/sourceLocator/recordId" },
    },
    {
      label: "content text",
      value: withSegment({ text: invalid }),
      issue: { code: "invalid-text", path: "/entries/0/content/0/text" },
    },
    {
      label: "content hash scheme",
      value: withSegment({ contentHash: { ...segment.contentHash, scheme: invalid } }),
      issue: { code: "invalid-content-hash", path: "/entries/0/content/0/contentHash" },
    },
    {
      label: "content hash digest",
      value: withSegment({ contentHash: { ...segment.contentHash, digest: invalid } }),
      issue: { code: "invalid-content-hash", path: "/entries/0/content/0/contentHash" },
    },
    {
      label: "content origin",
      value: withSegment({ origin: invalid }),
      issue: { code: "invalid-literal", path: "/entries/0/content/0/origin" },
    },
    {
      label: "origin confidence",
      value: withSegment({ originConfidence: invalid }),
      issue: { code: "invalid-literal", path: "/entries/0/content/0/originConfidence" },
    },
    {
      label: "source metadata key",
      value: withSegment({ sourceMetadata: { [invalid]: "synthetic" } }),
      issue: { code: "invalid-source-metadata", path: "/entries/0/content/0/sourceMetadata" },
    },
    {
      label: "source metadata value",
      value: withSegment({ sourceMetadata: { fixture: invalid } }),
      issue: { code: "invalid-source-metadata", path: "/entries/0/content/0/sourceMetadata" },
    },
  ];
}

function validDocument(): SessionDocument {
  return {
    identity: identity("session-one"),
    workspace: "/workspace",
    createdAt: "2026-07-13T10:00:00.000Z",
    updatedAt: "2026-07-13T10:01:00.000Z",
    lineageCoverage: "complete",
    relations: [relation()],
    entries: [canonicalEntry(0)],
  };
}

function identity(nativeId: string): SessionIdentity {
  return { source: { kind: "synthetic", instanceId: "local" }, nativeId };
}

function relation(): SessionRelation {
  return {
    kind: "parent",
    target: identity("parent-session"),
    confidence: "high",
  };
}

function canonicalEntry(ordinal: number, timestamp?: string): SessionEntry {
  return {
    ordinal,
    kind: "message",
    actor: "model",
    ...(timestamp === undefined ? {} : { timestamp }),
    sourceLocator: { uri: `memory://session/entry/${ordinal}` },
    content: [canonicalSegment(0, `entry ${ordinal}`)],
  };
}

function canonicalSegment(ordinal: number, text: string): TextContentSegment {
  return {
    kind: "text",
    ordinal,
    text,
    contentHash: hashContent(text),
    origin: "unknown",
    originConfidence: "unknown",
    sourceMetadata: { format: "synthetic" },
  };
}

function invalidResult(
  value: unknown,
  options: Parameters<typeof validateSessionDocument>[1] = {},
): Extract<ReturnType<typeof validateSessionDocument>, { readonly ok: false }> {
  const result = validateSessionDocument(value, options);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected an invalid document");
  return result;
}
