import { describe, expect, test } from "vitest";

import { hashContent } from "../../src/domain/content-hash.ts";
import {
  copySessionDocumentMetrics,
  createSessionDocumentMetrics,
  sameSessionDocumentMetrics,
} from "../../src/domain/session-document-metrics.ts";
import type { ContentSegment, SessionDocument } from "../../src/domain/session.ts";
import {
  createTestDocument,
  createTestEntry,
  createTestOmittedSegment,
  createTestSegment,
} from "../fixtures/session.ts";

describe("session document metrics", () => {
  test("counts occurrences and raw Unicode bytes without counting title text", () => {
    const repeatedText = "repeated café 🌍";
    const repeated = createTestSegment({ text: repeatedText });
    const document: SessionDocument = {
      ...createTestDocument(),
      title: "this title is excluded",
      relations: [
        {
          kind: "parent",
          target: {
            source: { kind: "synthetic", instanceId: "another-profile" },
            nativeId: "parent-session",
          },
          confidence: "high",
        },
      ],
      entries: [
        createTestEntry({
          ordinal: 0,
          content: [{ ...repeated, ordinal: 0 }, createTestOmittedSegment({ ordinal: 1 })],
        }),
        createTestEntry({
          ordinal: 1,
          content: [{ ...repeated, ordinal: 0 }],
        }),
      ],
    };

    const metrics = createSessionDocumentMetrics(document);

    expect(metrics).toEqual({
      relationCount: 1,
      entryCount: 2,
      segmentCount: 3,
      omittedSegmentCount: 1,
      textUtf8Bytes: Buffer.byteLength(repeatedText, "utf8") * 2,
    });
    expect(Object.isFrozen(metrics)).toBe(true);
  });

  test("counts empty documents exactly", () => {
    const document: SessionDocument = {
      ...createTestDocument(),
      title: "excluded title",
      relations: [],
      entries: [],
    };
    expect(createSessionDocumentMetrics(document)).toEqual({
      relationCount: 0,
      entryCount: 0,
      segmentCount: 0,
      omittedSegmentCount: 0,
      textUtf8Bytes: 0,
    });
  });

  test.each([
    { relationCount: -1 },
    { entryCount: 0.5 },
    { segmentCount: Number.MAX_SAFE_INTEGER + 1 },
    { omittedSegmentCount: Number.NaN },
    { textUtf8Bytes: Number.POSITIVE_INFINITY },
  ])("rejects invalid or unsafe totals: %o", (override) => {
    expect(() =>
      copySessionDocumentMetrics({
        relationCount: 0,
        entryCount: 0,
        segmentCount: 0,
        omittedSegmentCount: 0,
        textUtf8Bytes: 0,
        ...override,
      }),
    ).toThrow(/non-negative safe integers/u);
  });

  test("rejects omissions above the total segment count", () => {
    expect(() =>
      copySessionDocumentMetrics({
        relationCount: 0,
        entryCount: 1,
        segmentCount: 1,
        omittedSegmentCount: 2,
        textUtf8Bytes: 0,
      }),
    ).toThrow(/must not exceed/u);
  });

  test("copies values and compares every metric", () => {
    const metrics = copySessionDocumentMetrics({
      relationCount: 1,
      entryCount: 2,
      segmentCount: 3,
      omittedSegmentCount: 1,
      textUtf8Bytes: 9,
    });
    expect(sameSessionDocumentMetrics(metrics, { ...metrics })).toBe(true);
    expect(sameSessionDocumentMetrics(metrics, { ...metrics, textUtf8Bytes: 10 })).toBe(false);
  });

  test("counts each text segment rather than distinct hash values", () => {
    const text = "same content";
    const segment: ContentSegment = {
      kind: "text",
      ordinal: 0,
      text,
      contentHash: hashContent(text),
      origin: "model",
      originConfidence: "high",
      sourceMetadata: {},
    };
    const document = createTestDocument({
      entries: [
        createTestEntry({ ordinal: 0, content: [segment] }),
        createTestEntry({ ordinal: 1, content: [segment] }),
      ],
    });

    expect(createSessionDocumentMetrics(document).textUtf8Bytes).toBe(
      Buffer.byteLength(text, "utf8") * 2,
    );
  });
});
