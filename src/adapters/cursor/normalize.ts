import { hashContent } from "../../domain/content-hash.ts";
import { isCanonicalTimestamp } from "../../domain/canonical-timestamp.ts";
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
import type { ContentClass } from "../../domain/source-type.ts";
import {
  canonicalJson,
  denseArray,
  exactRecord,
  optionalPlainJsonRecord,
  optionalString,
  plainJsonRecord,
  requiredPlainJsonRecord,
  requiredString,
} from "./format-fields.ts";
import { malformedCursorFormat, unsupportedCursorFormat } from "./format-error.ts";
import type { CursorStoredMessage } from "./store.ts";

const MESSAGE_REQUIRED = new Set(["role", "content"]);
const MESSAGE_OPTIONAL = new Set(["id", "providerOptions"]);
const TEXT_KEYS = new Set(["type", "text"]);
const REASONING_KEYS = new Set(["type", "text", "signature", "providerOptions"]);
const REDACTED_REASONING_KEYS = new Set(["type", "data", "providerOptions"]);
const TOOL_CALL_KEYS = new Set(["type", "toolCallId", "toolName", "args"]);
const TOOL_RESULT_REQUIRED = new Set([
  "type",
  "toolCallId",
  "toolName",
  "result",
  "experimental_content",
]);
const TOOL_RESULT_OPTIONAL = new Set(["providerOptions"]);
const RESULT_TEXT_KEYS = new Set(["type", "text"]);
const RESULT_IMAGE_KEYS = new Set(["type", "mimeType", "data"]);
const MIME_TYPE = /^image\/[A-Za-z0-9!#$&^_.+-]+$/u;

interface Evidence {
  readonly actor: Actor;
  readonly origin: ContentOrigin;
  readonly confidence: OriginConfidence;
}

interface SegmentDraftText {
  readonly kind: "text";
  readonly text: string;
  readonly evidence: Evidence;
}

interface SegmentDraftOmitted {
  readonly kind: "omitted";
  readonly contentClass: ContentClass;
  readonly sourceType: string;
  readonly evidence: Evidence;
}

type SegmentDraft = SegmentDraftText | SegmentDraftOmitted;

interface MutableEntry {
  ordinal: number;
  kind: string;
  actor: Actor;
  relatedEntryOrdinal?: number;
  toolCallId?: string;
  toolName?: string;
  sourceLocator: { uri: string; recordId: string };
  content: readonly ContentSegment[];
}

interface ToolCall {
  readonly ordinal: number;
  readonly name: string;
  resultSeen: boolean;
}

export interface CursorNormalizationOptions {
  readonly identity: SessionIdentity;
  readonly logicalLocator: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly title?: string;
  readonly workspace?: string;
  readonly messages: readonly CursorStoredMessage[];
}

export function normalizeCursorSession(options: CursorNormalizationOptions): SessionDocument {
  validateOptions(options);
  const state = new CursorNormalizerState(options.logicalLocator);
  for (const [rootOrdinal, message] of options.messages.entries()) {
    if (message.rootOrdinal !== rootOrdinal) malformedCursorFormat();
    state.addMessage(message);
  }

  const candidate: SessionDocument = {
    identity: options.identity,
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    createdAt: options.createdAt,
    updatedAt: options.updatedAt,
    lineageCoverage: "unknown",
    relations: [],
    entries: state.finish(),
  };
  const validated = validateSessionDocument(candidate, { expectedIdentity: options.identity });
  if (!validated.ok) malformedCursorFormat();
  return validated.document;
}

class CursorNormalizerState {
  readonly #logicalLocator: string;
  readonly #entries: MutableEntry[] = [];
  readonly #calls = new Map<string, ToolCall>();

  constructor(logicalLocator: string) {
    this.#logicalLocator = logicalLocator;
  }

  addMessage(message: CursorStoredMessage): void {
    if (!Number.isSafeInteger(message.rootOrdinal) || message.rootOrdinal < 0) {
      malformedCursorFormat();
    }
    const record = exactRecord(message.value, MESSAGE_REQUIRED, MESSAGE_OPTIONAL);
    optionalString(record, "id");
    optionalPlainJsonRecord(record, "providerOptions");
    const role = requiredString(record, "role", true);
    switch (role) {
      case "system":
        this.#addScalarMessage(record.content, SYSTEM, message.rootOrdinal);
        return;
      case "user":
        this.#addUserMessage(record.content, message.rootOrdinal);
        return;
      case "assistant":
        this.#addAssistantMessage(record.content, message.rootOrdinal);
        return;
      case "tool":
        this.#addToolMessage(record.content, message.rootOrdinal);
        return;
      default:
        unsupportedCursorFormat();
    }
  }

  finish(): readonly SessionEntry[] {
    return Object.freeze(this.#entries);
  }

  #addScalarMessage(value: unknown, evidence: Evidence, rootOrdinal: number): void {
    if (typeof value !== "string") unsupportedCursorFormat();
    if (!value.isWellFormed()) malformedCursorFormat();
    this.#append("message", evidence, [text(value, evidence)], rootOrdinal, 0);
  }

  #addUserMessage(value: unknown, rootOrdinal: number): void {
    if (typeof value === "string") {
      this.#addScalarMessage(value, HUMAN, rootOrdinal);
      return;
    }
    for (const [itemOrdinal, item] of denseArray(value).entries()) {
      const record = exactRecord(item, TEXT_KEYS);
      if (requiredString(record, "type", true) !== "text") unsupportedCursorFormat();
      this.#append(
        "message",
        HUMAN,
        [text(requiredString(record, "text"), HUMAN)],
        rootOrdinal,
        itemOrdinal,
      );
    }
  }

  #addAssistantMessage(value: unknown, rootOrdinal: number): void {
    for (const [itemOrdinal, item] of denseArray(value).entries()) {
      const type = itemType(item);
      switch (type) {
        case "text": {
          const record = exactRecord(item, TEXT_KEYS);
          this.#append(
            "message",
            MODEL,
            [text(requiredString(record, "text"), MODEL)],
            rootOrdinal,
            itemOrdinal,
          );
          break;
        }
        case "reasoning": {
          const record = exactRecord(item, REASONING_KEYS);
          requiredString(record, "signature");
          requiredPlainJsonRecord(record, "providerOptions");
          this.#append(
            "reasoning",
            MODEL,
            [text(requiredString(record, "text"), MODEL)],
            rootOrdinal,
            itemOrdinal,
          );
          break;
        }
        case "redacted-reasoning": {
          const record = exactRecord(item, REDACTED_REASONING_KEYS);
          requiredString(record, "data");
          requiredPlainJsonRecord(record, "providerOptions");
          this.#append(
            "reasoning",
            MODEL,
            [omitted("unknown", "redacted-reasoning", MODEL)],
            rootOrdinal,
            itemOrdinal,
          );
          break;
        }
        case "tool-call":
          this.#addToolCall(item, rootOrdinal, itemOrdinal);
          break;
        default:
          unsupportedCursorFormat();
      }
    }
  }

  #addToolMessage(value: unknown, rootOrdinal: number): void {
    for (const [itemOrdinal, item] of denseArray(value).entries()) {
      if (itemType(item) !== "tool-result") unsupportedCursorFormat();
      this.#addToolResult(item, rootOrdinal, itemOrdinal);
    }
  }

  #addToolCall(value: unknown, rootOrdinal: number, itemOrdinal: number): void {
    const record = exactRecord(value, TOOL_CALL_KEYS);
    const callId = requiredString(record, "toolCallId", true);
    const toolName = requiredString(record, "toolName", true);
    if (this.#calls.has(callId)) malformedCursorFormat();
    const args = canonicalJson(requiredPlainJsonRecord(record, "args"));
    const ordinal = this.#append(
      "tool-call",
      MODEL,
      [text(args, MODEL)],
      rootOrdinal,
      itemOrdinal,
      { toolCallId: callId, toolName },
    );
    this.#calls.set(callId, { ordinal, name: toolName, resultSeen: false });
  }

  #addToolResult(value: unknown, rootOrdinal: number, itemOrdinal: number): void {
    const record = exactRecord(value, TOOL_RESULT_REQUIRED, TOOL_RESULT_OPTIONAL);
    optionalPlainJsonRecord(record, "providerOptions");
    const callId = requiredString(record, "toolCallId", true);
    const toolName = requiredString(record, "toolName", true);
    const call = this.#calls.get(callId);
    if (call === undefined || call.name !== toolName || call.resultSeen) malformedCursorFormat();
    call.resultSeen = true;

    const primary = toolResultText(record.result);
    const content: SegmentDraft[] = [text(primary.text, TOOL)];
    for (const item of denseArray(record.experimental_content)) {
      const type = itemType(item);
      if (type === "text") {
        const textRecord = exactRecord(item, RESULT_TEXT_KEYS);
        const extra = requiredString(textRecord, "text");
        if (!(primary.stringValue && extra === primary.text)) content.push(text(extra, TOOL));
      } else if (type === "image") {
        const image = exactRecord(item, RESULT_IMAGE_KEYS);
        const mimeType = requiredString(image, "mimeType", true);
        requiredString(image, "data");
        if (!MIME_TYPE.test(mimeType)) malformedCursorFormat();
        content.push(omitted("image", "image", TOOL));
      } else {
        unsupportedCursorFormat();
      }
    }

    this.#append("tool-result", TOOL, content, rootOrdinal, itemOrdinal, {
      toolCallId: callId,
      relatedEntryOrdinal: call.ordinal,
    });
  }

  #append(
    kind: string,
    evidence: Evidence,
    content: readonly SegmentDraft[],
    rootOrdinal: number,
    itemOrdinal: number,
    fields: {
      readonly relatedEntryOrdinal?: number;
      readonly toolCallId?: string;
      readonly toolName?: string;
    } = {},
  ): number {
    const ordinal = this.#entries.length;
    this.#entries.push({
      ordinal,
      kind,
      actor: evidence.actor,
      ...fields,
      sourceLocator: {
        uri: this.#logicalLocator,
        recordId: `${rootOrdinal}:${itemOrdinal}`,
      },
      content: content.map((segment, segmentOrdinal) =>
        materializeSegment(segment, segmentOrdinal),
      ),
    });
    return ordinal;
  }
}

const HUMAN: Evidence = { actor: "human", origin: "human", confidence: "high" };
const MODEL: Evidence = { actor: "model", origin: "model", confidence: "high" };
const TOOL: Evidence = { actor: "tool", origin: "tool", confidence: "high" };
const SYSTEM: Evidence = { actor: "system", origin: "system", confidence: "high" };

function validateOptions(options: CursorNormalizationOptions): void {
  if (
    options.logicalLocator.length === 0 ||
    !options.logicalLocator.isWellFormed() ||
    !isCanonicalTimestamp(options.createdAt) ||
    !isCanonicalTimestamp(options.updatedAt) ||
    options.updatedAt < options.createdAt ||
    (options.title !== undefined && !options.title.isWellFormed()) ||
    (options.workspace !== undefined && !options.workspace.isWellFormed())
  ) {
    malformedCursorFormat();
  }
}

function itemType(value: unknown): string {
  const record = plainJsonRecord(value);
  return requiredString(record, "type", true);
}

function toolResultText(value: unknown): { readonly text: string; readonly stringValue: boolean } {
  if (typeof value === "string") {
    if (!value.isWellFormed()) malformedCursorFormat();
    return { text: value, stringValue: true };
  }
  if (typeof value === "number") {
    return { text: canonicalJson(value), stringValue: false };
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return { text: canonicalJson(value), stringValue: false };
  }
  unsupportedCursorFormat();
}

function text(value: string, evidence: Evidence): SegmentDraftText {
  if (!value.isWellFormed()) malformedCursorFormat();
  return { kind: "text", text: value, evidence };
}

function omitted(
  contentClass: ContentClass,
  sourceType: string,
  evidence: Evidence,
): SegmentDraftOmitted {
  return { kind: "omitted", contentClass, sourceType, evidence };
}

function materializeSegment(segment: SegmentDraft, ordinal: number): ContentSegment {
  const base = {
    ordinal,
    origin: segment.evidence.origin,
    originConfidence: segment.evidence.confidence,
    sourceMetadata: {},
  };
  return segment.kind === "text"
    ? {
        ...base,
        kind: "text",
        text: segment.text,
        contentHash: hashContent(segment.text),
      }
    : {
        ...base,
        kind: "omitted",
        contentClass: segment.contentClass,
        sourceType: segment.sourceType,
      };
}
