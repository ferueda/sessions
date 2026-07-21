import type { SessionDocument } from "./session.ts";

export interface SessionDocumentMetrics {
  readonly relationCount: number;
  readonly entryCount: number;
  readonly segmentCount: number;
  readonly omittedSegmentCount: number;
  readonly textUtf8Bytes: number;
}

export function createSessionDocumentMetrics(
  document: Pick<SessionDocument, "relations" | "entries">,
): SessionDocumentMetrics {
  let segmentCount = 0;
  let omittedSegmentCount = 0;
  let textUtf8Bytes = 0;

  for (const entry of document.entries) {
    segmentCount = addCount(segmentCount, entry.content.length);
    for (const segment of entry.content) {
      if (segment.kind === "omitted") {
        omittedSegmentCount = addCount(omittedSegmentCount, 1);
      } else {
        textUtf8Bytes = addCount(textUtf8Bytes, Buffer.byteLength(segment.text, "utf8"));
      }
    }
  }

  return copySessionDocumentMetrics({
    relationCount: document.relations.length,
    entryCount: document.entries.length,
    segmentCount,
    omittedSegmentCount,
    textUtf8Bytes,
  });
}

export function copySessionDocumentMetrics(input: SessionDocumentMetrics): SessionDocumentMetrics {
  const relationCount = countAt(input.relationCount);
  const entryCount = countAt(input.entryCount);
  const segmentCount = countAt(input.segmentCount);
  const omittedSegmentCount = countAt(input.omittedSegmentCount);
  const textUtf8Bytes = countAt(input.textUtf8Bytes);
  if (omittedSegmentCount > segmentCount) {
    throw new TypeError("Omitted segment count must not exceed total segment count");
  }
  return Object.freeze({
    relationCount,
    entryCount,
    segmentCount,
    omittedSegmentCount,
    textUtf8Bytes,
  });
}

export function sameSessionDocumentMetrics(
  left: SessionDocumentMetrics,
  right: SessionDocumentMetrics,
): boolean {
  return (
    left.relationCount === right.relationCount &&
    left.entryCount === right.entryCount &&
    left.segmentCount === right.segmentCount &&
    left.omittedSegmentCount === right.omittedSegmentCount &&
    left.textUtf8Bytes === right.textUtf8Bytes
  );
}

function addCount(left: number, right: number): number {
  return countAt(left + right);
}

function countAt(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Session document metrics must be non-negative safe integers");
  }
  return value;
}
