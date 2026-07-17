import { hashContent } from "../../domain/content-hash.ts";
import { snapshotPlainRecord, type UnknownRecord } from "../../domain/data-snapshot.ts";
import { validateSessionDocument } from "../../domain/session-validation.ts";
import type {
  Actor,
  ContentOrigin,
  ContentSegment,
  OriginConfidence,
  SessionDocument,
  SessionEntry,
  SessionIdentity,
} from "../../domain/session.ts";
import {
  canonicalJson,
  denseArray,
  exactRecord,
  plainJsonRecord,
  requiredString,
} from "./format-fields.ts";
import { malformedCursorFormat, unsupportedCursorFormat } from "./format-error.ts";

const MESSAGE_KEYS = new Set(["role", "message"]);
const MESSAGE_BODY_KEYS = new Set(["content"]);
const TEXT_KEYS = new Set(["type", "text"]);
const TOOL_USE_KEYS = new Set(["type", "name", "input"]);
const TURN_SUCCESS_KEYS = new Set(["type", "status"]);
const TURN_FAILURE_KEYS = new Set(["type", "status", "error"]);

interface Evidence {
  readonly actor: Actor;
  readonly origin: ContentOrigin;
  readonly confidence: OriginConfidence;
}

export interface CursorJsonlNormalizationOptions {
  readonly identity: SessionIdentity;
  readonly logicalLocator: string;
}

export interface CursorJsonlNormalizer {
  readonly addRecord: (value: unknown, recordOrdinal: number) => void;
  readonly finish: () => SessionDocument;
}

/** Creates a normalizer for Cursor's reduced agent-transcript JSONL format. */
export function createCursorJsonlNormalizer(
  options: CursorJsonlNormalizationOptions,
): CursorJsonlNormalizer {
  const state = new CursorJsonlNormalizerState(options);
  return {
    addRecord: (value, recordOrdinal) => state.addRecord(value, recordOrdinal),
    finish: () => state.finish(),
  };
}

class CursorJsonlNormalizerState {
  readonly #options: CursorJsonlNormalizationOptions;
  readonly #entries: SessionEntry[] = [];
  #nextRecordOrdinal = 0;
  #finished = false;

  constructor(options: CursorJsonlNormalizationOptions) {
    if (options.logicalLocator.length === 0 || !options.logicalLocator.isWellFormed()) {
      malformedCursorFormat();
    }
    this.#options = options;
  }

  addRecord(value: unknown, recordOrdinal: number): void {
    if (this.#finished) throw new TypeError("Cursor JSONL normalizer is already finished");
    if (recordOrdinal !== this.#nextRecordOrdinal) malformedCursorFormat();
    this.#nextRecordOrdinal += 1;

    const record = recordSnapshot(value);
    if (Object.hasOwn(record, "role")) {
      this.#addMessage(record, recordOrdinal);
      return;
    }
    if (Object.hasOwn(record, "type")) {
      this.#addLifecycle(record, recordOrdinal);
      return;
    }
    unsupportedCursorFormat();
  }

  finish(): SessionDocument {
    if (this.#finished) throw new TypeError("Cursor JSONL normalizer is already finished");
    this.#finished = true;

    const candidate: SessionDocument = {
      identity: this.#options.identity,
      lineageCoverage: "unknown",
      relations: [],
      entries: this.#entries,
    };
    const validated = validateSessionDocument(candidate, {
      expectedIdentity: this.#options.identity,
    });
    if (!validated.ok) malformedCursorFormat();
    return validated.document;
  }

  #addMessage(value: unknown, recordOrdinal: number): void {
    const record = exactRecord(value, MESSAGE_KEYS);
    const role = requiredString(record, "role", true);
    const body = exactRecord(record.message, MESSAGE_BODY_KEYS);
    const content = denseArray(body.content);

    if (role === "user") {
      for (const [itemOrdinal, item] of content.entries()) {
        const textRecord = exactTextItem(item);
        this.#append(
          "message",
          HUMAN,
          requiredString(textRecord, "text"),
          recordOrdinal,
          itemOrdinal,
        );
      }
      return;
    }
    if (role !== "assistant") unsupportedCursorFormat();

    for (const [itemOrdinal, item] of content.entries()) {
      const itemRecord = recordSnapshot(item);
      const type = requiredString(itemRecord, "type", true);
      if (type === "text") {
        const textRecord = exactRecord(itemRecord, TEXT_KEYS);
        this.#append(
          "message",
          MODEL,
          requiredString(textRecord, "text"),
          recordOrdinal,
          itemOrdinal,
        );
      } else if (type === "tool_use") {
        const tool = exactRecord(itemRecord, TOOL_USE_KEYS);
        this.#append(
          "tool-call",
          MODEL,
          toolInput(tool.input),
          recordOrdinal,
          itemOrdinal,
          requiredString(tool, "name", true),
        );
      } else {
        unsupportedCursorFormat();
      }
    }
  }

  #addLifecycle(value: unknown, recordOrdinal: number): void {
    const generic = recordSnapshot(value);
    if (requiredString(generic, "type", true) !== "turn_ended") {
      unsupportedCursorFormat();
    }

    const status = requiredString(generic, "status", true);
    if (status === "success") {
      exactRecord(generic, TURN_SUCCESS_KEYS);
      this.#append("turn-completed", SYSTEM, undefined, recordOrdinal, 0);
      return;
    }
    if (status === "error" || status === "aborted") {
      const record = exactRecord(generic, TURN_FAILURE_KEYS);
      this.#append(
        status === "error" ? "turn-error" : "turn-aborted",
        SYSTEM,
        requiredString(record, "error"),
        recordOrdinal,
        0,
      );
      return;
    }
    unsupportedCursorFormat();
  }

  #append(
    kind: string,
    evidence: Evidence,
    value: string | undefined,
    recordOrdinal: number,
    itemOrdinal: number,
    toolName?: string,
  ): void {
    const ordinal = this.#entries.length;
    this.#entries.push({
      ordinal,
      kind,
      actor: evidence.actor,
      ...(toolName === undefined ? {} : { toolName }),
      sourceLocator: {
        uri: this.#options.logicalLocator,
        recordId: `${recordOrdinal}:${itemOrdinal}`,
      },
      content: value === undefined ? [] : [textSegment(value, evidence)],
    });
  }
}

const HUMAN: Evidence = { actor: "human", origin: "human", confidence: "high" };
const MODEL: Evidence = { actor: "model", origin: "model", confidence: "high" };
const SYSTEM: Evidence = { actor: "system", origin: "system", confidence: "high" };

function exactTextItem(value: unknown): ReturnType<typeof exactRecord> {
  const record = exactRecord(value, TEXT_KEYS);
  if (requiredString(record, "type", true) !== "text") unsupportedCursorFormat();
  return record;
}

function recordSnapshot(value: unknown): UnknownRecord {
  const snapshot = snapshotPlainRecord(value);
  if (!snapshot.ok) malformedCursorFormat();
  return snapshot.record;
}

function toolInput(value: unknown): string {
  if (typeof value === "string") {
    if (!value.isWellFormed()) malformedCursorFormat();
    return value;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return canonicalJson(plainJsonRecord(value));
  }
  unsupportedCursorFormat();
}

function textSegment(value: string, evidence: Evidence): ContentSegment {
  if (!value.isWellFormed()) malformedCursorFormat();
  return {
    ordinal: 0,
    kind: "text",
    text: value,
    contentHash: hashContent(value),
    origin: evidence.origin,
    originConfidence: evidence.confidence,
    sourceMetadata: {},
  };
}
