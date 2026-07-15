import { describe, expect, test } from "vitest";

import {
  MAX_SELECTED_ENTRIES,
  MAX_SELECTED_RELATIONS,
  MAX_SELECTED_SEGMENTS,
  MAX_SELECTED_SEGMENT_TEXT_UTF8_BYTES,
  MAX_SELECTED_TRANSCRIPT_TEXT_UTF8_BYTES,
  selectSessionTranscript,
  selectText,
} from "../../src/application/session-presentation.ts";
import type { SessionQuerySummary } from "../../src/domain/session-query.ts";
import { projectPublicSessionDocument } from "../../src/domain/public-session-document.ts";
import type { SessionDocument, SessionRelation } from "../../src/domain/session.ts";
import {
  createTestDocument,
  createTestEntry,
  createTestIdentity,
  createTestOmittedSegment,
  createTestSegment,
} from "../fixtures/session.ts";

describe("session presentation selection", () => {
  test("truncates at Unicode code-point boundaries with exact UTF-8 accounting", () => {
    expect(selectText("A😀B", 5)).toEqual({
      text: "A😀",
      truncated: true,
      originalUtf8Bytes: 6,
      emittedUtf8Bytes: 5,
    });
    expect(selectText("A😀B", 6)).toEqual({
      text: "A😀B",
      truncated: false,
      originalUtf8Bytes: 6,
      emittedUtf8Bytes: 6,
    });
    expect(() => selectText("\ud800", 8)).toThrow(TypeError);
    expect(() => selectText("text", -1)).toThrow(TypeError);
  });

  test("bounds relations, entries, and segment records in canonical order", () => {
    const relations = Array.from({ length: MAX_SELECTED_RELATIONS + 1 }, (_, ordinal) =>
      relation(ordinal),
    );
    const entries = Array.from({ length: MAX_SELECTED_ENTRIES + 1 }, (_, ordinal) =>
      createTestEntry({
        ordinal,
        content:
          ordinal === 0
            ? Array.from({ length: MAX_SELECTED_SEGMENTS + 1 }, (_, segmentOrdinal) =>
                createTestSegment({ ordinal: segmentOrdinal, text: "x" }),
              )
            : [],
      }),
    );

    const result = selected(createTestDocument({ entries }), "bounded", relations);

    expect(result.relations).toHaveLength(MAX_SELECTED_RELATIONS);
    expect(result.entries).toHaveLength(MAX_SELECTED_ENTRIES);
    expect(result.entries[0]!.content).toHaveLength(MAX_SELECTED_SEGMENTS);
    expect(result.entries[0]!.omittedSegmentCount).toBe(1);
    expect(result.snapshot.selection).toMatchObject({
      relations: { selected: 50, total: 51, truncated: true },
      entries: {
        selected: 50,
        total: 51,
        truncated: true,
        firstOrdinal: 0,
        lastOrdinal: 49,
      },
      segments: { selected: 100, total: 101, truncated: true },
    });
  });

  test("accounts for per-segment and aggregate text limits separately", () => {
    const perSegment = createTestSegment({
      ordinal: 0,
      text: "a".repeat(MAX_SELECTED_SEGMENT_TEXT_UTF8_BYTES + 1),
    });
    const aggregate = Array.from({ length: 33 }, (_, ordinal) =>
      createTestSegment({
        ordinal: ordinal + 1,
        text: "b".repeat(MAX_SELECTED_SEGMENT_TEXT_UTF8_BYTES),
      }),
    );
    const omitted = createTestOmittedSegment({ ordinal: 34, contentClass: "image" });
    const document = createTestDocument({
      entries: [createTestEntry({ content: [perSegment, ...aggregate, omitted] })],
    });

    const result = selected(document, "bounded");
    const textSegments = result.entries[0]!.content.filter((segment) => segment.kind === "text");

    expect(textSegments[0]!.text).toEqual({
      text: "a".repeat(MAX_SELECTED_SEGMENT_TEXT_UTF8_BYTES),
      truncated: true,
      originalUtf8Bytes: MAX_SELECTED_SEGMENT_TEXT_UTF8_BYTES + 1,
      emittedUtf8Bytes: MAX_SELECTED_SEGMENT_TEXT_UTF8_BYTES,
    });
    expect(result.snapshot.selection.segmentText).toEqual({
      emittedUtf8Bytes: MAX_SELECTED_TRANSCRIPT_TEXT_UTF8_BYTES,
      originalUtf8Bytes:
        MAX_SELECTED_SEGMENT_TEXT_UTF8_BYTES + 1 + 33 * MAX_SELECTED_SEGMENT_TEXT_UTF8_BYTES,
      truncated: true,
    });
    expect(result.snapshot.selection.truncatedTextSegments).toBe(3);
    expect(result.snapshot.selection.canonicalOmittedSegments).toBe(1);
  });

  test("full selection retains all eligible fields without exposing private document data", () => {
    const title = "😀".repeat(3_000);
    const document: SessionDocument = {
      ...createTestDocument({
        entries: [
          createTestEntry({
            content: [
              createTestSegment({
                text: "z".repeat(MAX_SELECTED_SEGMENT_TEXT_UTF8_BYTES + 1),
              }),
            ],
          }),
        ],
      }),
      title,
      workspace: "/private/workspace",
    };

    const result = selected(document, "full");
    const serialized = JSON.stringify(result);

    expect(result.snapshot.title).toEqual({
      text: title,
      truncated: false,
      originalUtf8Bytes: 12_000,
      emittedUtf8Bytes: 12_000,
    });
    expect(result.snapshot.selection.mode).toBe("full");
    expect(result.snapshot.selection.segmentText.truncated).toBe(false);
    expect(result.entries[0]!.content[0]).toMatchObject({
      kind: "text",
      text: { truncated: false },
    });
    expect(serialized).not.toContain("/private/workspace");
    expect(serialized).not.toContain("memory://synthetic");
    expect(serialized).not.toContain("sourceMetadata");
    expect(Object.isFrozen(result.snapshot.title)).toBe(true);
    expect(Object.isFrozen(result.entries[0]!.content[0])).toBe(true);
  });

  test("uses canonical document fields for a retained snapshot", () => {
    const document = createTestDocument({ includeMetadata: false, entries: [] });
    const result = selectSessionTranscript({
      summary: {
        ...summary(document),
        title: "divergent summary title",
        createdAt: "2026-07-14T00:00:00.000Z",
      },
      document: projectPublicSessionDocument(document),
      mode: "bounded",
    });

    expect(result.snapshot).not.toHaveProperty("title");
    expect(result.snapshot).not.toHaveProperty("createdAt");
    expect(result.snapshot.selection.entries).toEqual({
      selected: 0,
      total: 0,
      truncated: false,
      firstOrdinal: null,
      lastOrdinal: null,
    });
  });
});

function selected(
  document: SessionDocument,
  mode: "bounded" | "full",
  relations: readonly SessionRelation[] = document.relations,
) {
  const withRelations = { ...document, relations };
  return selectSessionTranscript({
    summary: summary(withRelations),
    document: projectPublicSessionDocument(withRelations),
    mode,
  });
}

function summary(document: SessionDocument): SessionQuerySummary {
  return {
    identity: document.identity,
    ...(document.title === undefined ? {} : { title: document.title }),
    ...(document.createdAt === undefined ? {} : { createdAt: document.createdAt }),
    ...(document.updatedAt === undefined ? {} : { updatedAt: document.updatedAt }),
    freshness: "current",
    sourceState: "present",
    capturedAt: "2026-07-15T12:00:00.000Z",
    sourceObservedAt: "2026-07-15T12:00:00.000Z",
    adapterVersion: "synthetic-v1",
    documentDigest: {
      scheme: "sha256-sessions-document-jcs-v1",
      digest: "0".repeat(64),
    },
  };
}

function relation(ordinal: number): SessionRelation {
  return {
    kind: ordinal % 2 === 0 ? "parent" : "child",
    target: createTestIdentity(`related-${String(ordinal)}`),
    confidence: "high",
  };
}
