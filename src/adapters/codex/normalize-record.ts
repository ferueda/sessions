import type { UnknownRecord } from "../../domain/data-snapshot.ts";
import type { Actor, ContentOrigin, OriginConfidence } from "../../domain/session.ts";
import type { ContentClass } from "../../domain/source-type.ts";
import {
  canonicalizeCodexDiscriminator,
  DEFERRED_EVENT_TYPES,
  DEFERRED_RESPONSE_TYPES,
  SKIPPED_EVENT_TYPES,
} from "./format-support.ts";
import {
  arrayValue,
  discriminator,
  optionalArray,
  optionalNonNullStringArray,
  optionalNullableStringArray,
  optionalRawString,
  optionalRecord,
  optionalText,
  own,
  plainRecord,
  requiredArray,
  requiredNumber,
  requiredRawString,
  requiredText,
  throwMalformed,
  wellFormed,
} from "./normalize-fields.ts";

export type Evidence = {
  readonly actor: Actor;
  readonly origin: ContentOrigin;
  readonly confidence: OriginConfidence;
};

export type SegmentDraft =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly origin: ContentOrigin;
      readonly confidence: OriginConfidence;
    }
  | {
      readonly kind: "omitted";
      readonly contentClass: ContentClass;
      readonly sourceType: string;
      readonly origin: ContentOrigin;
      readonly confidence: OriginConfidence;
    };

export interface EntryDraft {
  readonly kind: string;
  readonly actor: Actor;
  readonly timestamp?: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly toolNamespace?: string;
  readonly content: readonly SegmentDraft[];
  readonly recordOrdinal: number;
  readonly link?:
    | { readonly kind: "tool-call" | "tool-result"; readonly id: string }
    | { readonly kind: "turn-start" | "turn-terminal"; readonly id: string };
}

export interface ParsedRecord {
  readonly entries: readonly EntryDraft[];
  readonly messageFamily?: "event" | "response";
}

export const INJECTED: Evidence = {
  actor: "system",
  origin: "injected",
  confidence: "high",
};

const HUMAN: Evidence = { actor: "human", origin: "human", confidence: "high" };
const MODEL: Evidence = { actor: "model", origin: "model", confidence: "high" };
const SYSTEM: Evidence = { actor: "system", origin: "system", confidence: "high" };
const TOOL: Evidence = { actor: "tool", origin: "tool", confidence: "high" };
const DELEGATED: Evidence = { actor: "model", origin: "delegated", confidence: "high" };
const UNKNOWN: Evidence = {
  actor: "unknown",
  origin: "unknown",
  confidence: "unknown",
};
const IMAGE_DETAILS = new Set(["auto", "low", "high", "original"]);
const ABORT_REASONS = new Set(["interrupted", "replaced", "review_ended", "budget_limited"]);

export function responseItem(
  payload: UnknownRecord,
  timestamp: string | undefined,
  recordOrdinal: number,
): ParsedRecord {
  const type = discriminator(payload, "type");
  switch (type) {
    case "message":
      return {
        entries: [responseMessage(payload, timestamp, recordOrdinal)],
        messageFamily: "response",
      };
    case "agent_message":
      return { entries: [responseAgentMessage(payload, timestamp, recordOrdinal)] };
    case "reasoning":
      return { entries: [reasoning(payload, timestamp, recordOrdinal)] };
    case "function_call":
      return { entries: [toolCall(payload, "arguments", timestamp, recordOrdinal)] };
    case "custom_tool_call":
      return { entries: [toolCall(payload, "input", timestamp, recordOrdinal)] };
    case "function_call_output":
    case "custom_tool_call_output":
      return { entries: [toolResult(payload, timestamp, recordOrdinal)] };
    case "compaction":
    case "compaction_summary": {
      requiredRawString(payload, "encrypted_content");
      return {
        entries: [
          entry(
            "compaction",
            SYSTEM,
            [omitted("unknown", "encrypted-compaction", SYSTEM)],
            timestamp,
            recordOrdinal,
          ),
        ],
      };
    }
    case "context_compaction": {
      const encrypted = optionalRawString(payload, "encrypted_content");
      return {
        entries: [
          entry(
            "compaction",
            SYSTEM,
            encrypted === undefined ? [] : [omitted("unknown", "encrypted-compaction", SYSTEM)],
            timestamp,
            recordOrdinal,
          ),
        ],
      };
    }
    case "compaction_trigger":
      return { entries: [] };
    default:
      if (DEFERRED_RESPONSE_TYPES.has(type)) {
        return { entries: [unknownEntry(type, timestamp, recordOrdinal)] };
      }
      return { entries: [unknownEntry(type, timestamp, recordOrdinal)] };
  }
}

export function eventMessage(
  payload: UnknownRecord,
  timestamp: string | undefined,
  recordOrdinal: number,
): ParsedRecord {
  const type = discriminator(payload, "type");
  switch (type) {
    case "user_message": {
      const content: SegmentDraft[] = [text(requiredText(payload, "message"), HUMAN)];
      for (const ignored of optionalNullableStringArray(payload, "images")) {
        void ignored;
        content.push(omitted("image", "input-image", HUMAN));
      }
      for (const ignored of optionalNonNullStringArray(payload, "local_images")) {
        void ignored;
        content.push(omitted("image", "local-image", HUMAN));
      }
      return {
        entries: [entry("message", HUMAN, content, timestamp, recordOrdinal)],
        messageFamily: "event",
      };
    }
    case "agent_message":
      return {
        entries: [
          entry(
            "message",
            MODEL,
            [text(requiredText(payload, "message"), MODEL)],
            timestamp,
            recordOrdinal,
          ),
        ],
        messageFamily: "event",
      };
    case "agent_reasoning":
      return {
        entries: [
          entry(
            "reasoning-summary",
            MODEL,
            [text(requiredText(payload, "text"), MODEL)],
            timestamp,
            recordOrdinal,
          ),
        ],
      };
    case "task_started":
    case "turn_started": {
      const id = requiredText(payload, "turn_id", true);
      return {
        entries: [
          {
            ...entry("turn-started", SYSTEM, [], timestamp, recordOrdinal),
            link: { kind: "turn-start", id },
          },
        ],
      };
    }
    case "task_complete":
    case "turn_complete":
      return { entries: completedTurn(payload, timestamp, recordOrdinal) };
    case "turn_aborted": {
      const turnId = optionalText(payload, "turn_id", true);
      const reason = requiredRawString(payload, "reason");
      if (!ABORT_REASONS.has(reason)) throwMalformed();
      return {
        entries: [
          {
            ...entry("turn-aborted", SYSTEM, [], timestamp, recordOrdinal),
            ...(turnId === undefined
              ? {}
              : { link: { kind: "turn-terminal" as const, id: turnId } }),
          },
        ],
      };
    }
    case "thread_rolled_back": {
      const count = requiredNumber(payload, "num_turns");
      if (!Number.isInteger(count) || count < 0 || count > 4_294_967_295) throwMalformed();
      return { entries: [entry("rollback", SYSTEM, [], timestamp, recordOrdinal)] };
    }
    case "context_compacted":
      return { entries: [entry("compaction", SYSTEM, [], timestamp, recordOrdinal)] };
    case "error":
    case "warning":
    case "guardian_warning":
      return {
        entries: [diagnostic([requiredText(payload, "message")], timestamp, recordOrdinal)],
      };
    case "stream_error": {
      const details = optionalText(payload, "additional_details");
      return {
        entries: [
          diagnostic(
            [requiredText(payload, "message"), ...(details === undefined ? [] : [details])],
            timestamp,
            recordOrdinal,
          ),
        ],
      };
    }
    case "deprecation_notice": {
      const details = optionalText(payload, "details");
      return {
        entries: [
          diagnostic(
            [requiredText(payload, "summary"), ...(details === undefined ? [] : [details])],
            timestamp,
            recordOrdinal,
          ),
        ],
      };
    }
    default:
      if (SKIPPED_EVENT_TYPES.has(type)) return { entries: [] };
      if (DEFERRED_EVENT_TYPES.has(type)) {
        return { entries: [unknownEntry(type, timestamp, recordOrdinal)] };
      }
      return { entries: [unknownEntry(type, timestamp, recordOrdinal)] };
  }
}

export function interAgentCommunication(
  payload: UnknownRecord,
  timestamp: string | undefined,
  recordOrdinal: number,
): EntryDraft {
  requiredRawString(payload, "author");
  requiredRawString(payload, "recipient");
  const content: SegmentDraft[] = [text(requiredText(payload, "content"), DELEGATED)];
  if (optionalRawString(payload, "encrypted_content") !== undefined) {
    content.push(omitted("unknown", "encrypted-agent-content", DELEGATED));
  }
  return entry("inter-agent-message", DELEGATED, content, timestamp, recordOrdinal);
}

export function compacted(
  payload: UnknownRecord,
  timestamp: string | undefined,
  recordOrdinal: number,
): readonly EntryDraft[] {
  const message = requiredText(payload, "message");
  return [
    entry("compaction", SYSTEM, [], timestamp, recordOrdinal),
    entry("injected-context", INJECTED, [text(message, INJECTED)], timestamp, recordOrdinal),
  ];
}

export function turnContext(
  payload: UnknownRecord,
  timestamp: string | undefined,
  recordOrdinal: number,
): readonly EntryDraft[] {
  optionalText(payload, "turn_id", true);
  const user = optionalText(payload, "user_instructions");
  const developer = optionalText(payload, "developer_instructions");
  return [user, developer]
    .filter((value): value is string => value !== undefined)
    .map((value) =>
      entry("injected-context", INJECTED, [text(value, INJECTED)], timestamp, recordOrdinal),
    );
}

export function unknownEntry(
  sourceDiscriminator: string,
  timestamp: string | undefined,
  recordOrdinal: number,
): EntryDraft {
  return entry(
    "unknown",
    UNKNOWN,
    [omitted("unknown", canonicalizeCodexDiscriminator(sourceDiscriminator), UNKNOWN)],
    timestamp,
    recordOrdinal,
  );
}

export function entry(
  kind: string,
  evidence: Evidence,
  content: readonly SegmentDraft[],
  timestamp: string | undefined,
  recordOrdinal: number,
): EntryDraft {
  return {
    kind,
    actor: evidence.actor,
    ...(timestamp === undefined ? {} : { timestamp }),
    content,
    recordOrdinal,
  };
}

export function text(value: string, evidence: Evidence): SegmentDraft {
  return {
    kind: "text",
    text: value,
    origin: evidence.origin,
    confidence: evidence.confidence,
  };
}

function responseMessage(
  payload: UnknownRecord,
  timestamp: string | undefined,
  recordOrdinal: number,
): EntryDraft {
  const role = requiredRawString(payload, "role");
  const evidence = roleEvidence(role);
  const phase = optionalRawString(payload, "phase");
  if (phase !== undefined && phase !== "commentary" && phase !== "final_answer") {
    throwMalformed();
  }
  const content = requiredArray(payload, "content").map((item) => messageSegment(item, evidence));
  return entry("message", evidence, content, timestamp, recordOrdinal);
}

function responseAgentMessage(
  payload: UnknownRecord,
  timestamp: string | undefined,
  recordOrdinal: number,
): EntryDraft {
  requiredRawString(payload, "author");
  requiredRawString(payload, "recipient");
  const content = requiredArray(payload, "content").map((item) => {
    const record = plainRecord(item);
    const type = discriminator(record, "type");
    if (type === "input_text") return text(requiredText(record, "text"), DELEGATED);
    if (type === "encrypted_content") {
      requiredRawString(record, "encrypted_content");
      return omitted("unknown", "encrypted-agent-content", DELEGATED);
    }
    return omitted("unknown", "unknown-content-item", DELEGATED);
  });
  return entry("inter-agent-message", DELEGATED, content, timestamp, recordOrdinal);
}

function reasoning(
  payload: UnknownRecord,
  timestamp: string | undefined,
  recordOrdinal: number,
): EntryDraft {
  const content: SegmentDraft[] = requiredArray(payload, "summary").map((item) => {
    const record = plainRecord(item);
    const type = discriminator(record, "type");
    if (type === "summary_text") return text(requiredText(record, "text"), MODEL);
    return omitted("unknown", "unknown-content-item", MODEL);
  });
  for (const item of optionalArray(payload, "content") ?? []) {
    const record = plainRecord(item);
    const type = discriminator(record, "type");
    if (type === "reasoning_text" || type === "text") {
      requiredRawString(record, "text");
      content.push(omitted("unknown", "reasoning-content", MODEL));
    } else {
      content.push(omitted("unknown", "unknown-content-item", MODEL));
    }
  }
  if (optionalRawString(payload, "encrypted_content") !== undefined) {
    content.push(omitted("unknown", "encrypted-reasoning", MODEL));
  }
  return entry("reasoning-summary", MODEL, content, timestamp, recordOrdinal);
}

function toolCall(
  payload: UnknownRecord,
  inputField: "arguments" | "input",
  timestamp: string | undefined,
  recordOrdinal: number,
): EntryDraft {
  const callId = requiredText(payload, "call_id", true);
  const name = requiredText(payload, "name", true);
  const namespace = optionalText(payload, "namespace", true);
  const input = requiredText(payload, inputField);
  return {
    ...entry("tool-call", MODEL, [text(input, MODEL)], timestamp, recordOrdinal),
    toolCallId: callId,
    toolName: name,
    ...(namespace === undefined ? {} : { toolNamespace: namespace }),
    link: { kind: "tool-call", id: callId },
  };
}

function toolResult(
  payload: UnknownRecord,
  timestamp: string | undefined,
  recordOrdinal: number,
): EntryDraft {
  const callId = requiredText(payload, "call_id", true);
  const output = own(payload, "output");
  if (!output.present) throwMalformed();
  const content =
    typeof output.value === "string"
      ? [text(wellFormed(output.value), TOOL)]
      : outputSegments(output.value);
  return {
    ...entry("tool-result", TOOL, content, timestamp, recordOrdinal),
    toolCallId: callId,
    link: { kind: "tool-result", id: callId },
  };
}

function outputSegments(value: unknown): readonly SegmentDraft[] {
  return arrayValue(value).map((item) => {
    const record = plainRecord(item);
    const type = discriminator(record, "type");
    if (type === "input_text") return text(requiredText(record, "text"), TOOL);
    if (type === "input_image") {
      validateInputImage(record);
      return omitted("image", "input-image", TOOL);
    }
    if (type === "encrypted_content") {
      requiredRawString(record, "encrypted_content");
      return omitted("unknown", "encrypted-tool-content", TOOL);
    }
    return omitted("structured", "unknown-content-item", TOOL);
  });
}

function completedTurn(
  payload: UnknownRecord,
  timestamp: string | undefined,
  recordOrdinal: number,
): readonly EntryDraft[] {
  const id = requiredText(payload, "turn_id", true);
  const error = optionalRecord(payload, "error");
  const marker: EntryDraft = {
    ...entry("turn-completed", SYSTEM, [], timestamp, recordOrdinal),
    link: { kind: "turn-terminal", id },
  };
  if (error === undefined) return [marker];
  return [marker, diagnostic([requiredText(error, "message")], timestamp, recordOrdinal)];
}

function messageSegment(value: unknown, evidence: Evidence): SegmentDraft {
  const record = plainRecord(value);
  const type = discriminator(record, "type");
  if (type === "input_text" || type === "output_text") {
    return text(requiredText(record, "text"), evidence);
  }
  if (type === "input_image") {
    validateInputImage(record);
    return omitted("image", "input-image", evidence);
  }
  return omitted("unknown", "unknown-content-item", evidence);
}

function validateInputImage(record: UnknownRecord): void {
  requiredRawString(record, "image_url");
  const detail = optionalRawString(record, "detail");
  if (detail !== undefined && !IMAGE_DETAILS.has(detail)) throwMalformed();
}

function roleEvidence(role: string): Evidence {
  switch (role) {
    case "user":
      return HUMAN;
    case "assistant":
      return MODEL;
    case "developer":
      return INJECTED;
    case "system":
      return SYSTEM;
    default:
      throwMalformed();
  }
}

function diagnostic(
  messages: readonly string[],
  timestamp: string | undefined,
  recordOrdinal: number,
): EntryDraft {
  return entry(
    "diagnostic",
    SYSTEM,
    messages.map((message) => text(message, SYSTEM)),
    timestamp,
    recordOrdinal,
  );
}

function omitted(contentClass: ContentClass, sourceType: string, evidence: Evidence): SegmentDraft {
  return {
    kind: "omitted",
    contentClass,
    sourceType,
    origin: evidence.origin,
    confidence: evidence.confidence,
  };
}
