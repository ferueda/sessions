import { hashContent } from "../../domain/content-hash.ts";
import type { UnknownRecord } from "../../domain/data-snapshot.ts";
import type {
  Actor,
  ContentSegment,
  SessionDocument,
  SessionEntry,
  SessionIdentity,
} from "../../domain/session.ts";
import { CodexLineageTracker } from "./lineage.ts";
import {
  discriminator,
  optionalRecord,
  optionalText,
  plainRecord,
  requiredRecord,
  requiredText,
  throwMalformed,
  timestampField,
} from "./normalize-fields.ts";
import {
  compacted,
  entry,
  eventMessage,
  INJECTED,
  interAgentCommunication,
  responseItem,
  text,
  turnContext,
  unknownEntry,
  type EntryDraft,
  type ParsedRecord,
} from "./normalize-record.ts";

export interface CodexRolloutNormalizationOptions {
  readonly identity: SessionIdentity;
  readonly logicalLocator: string;
  readonly stateParentNativeId?: string;
  readonly title?: string;
  readonly workspace?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface CodexRolloutNormalizer {
  readonly addRecord: (value: unknown, recordOrdinal: number) => void;
  readonly breakAdjacency: () => void;
  readonly finish: () => SessionDocument;
}

interface MutableEntry {
  ordinal: number;
  kind: string;
  actor: Actor;
  timestamp?: string;
  relatedEntryOrdinal?: number;
  toolCallId?: string;
  toolName?: string;
  toolNamespace?: string;
  sourceLocator: { uri: string; recordId: string };
  content: readonly ContentSegment[];
}

export function createCodexRolloutNormalizer(
  options: CodexRolloutNormalizationOptions,
): CodexRolloutNormalizer {
  const state = new CodexNormalizerState(options);
  return {
    addRecord: (value, recordOrdinal) => state.addRecord(value, recordOrdinal),
    breakAdjacency: () => state.breakAdjacency(),
    finish: () => state.finish(),
  };
}

class CodexNormalizerState {
  readonly #options: CodexRolloutNormalizationOptions;
  readonly #entries: MutableEntry[] = [];
  readonly #lineage: CodexLineageTracker;
  readonly #toolCalls = new Map<string, number>();
  readonly #toolResults = new Map<string, number>();
  readonly #turnStarts = new Map<string, number[]>();
  readonly #turnTerminals = new Map<string, number[]>();
  #previousMessage:
    | { readonly family: "event" | "response"; readonly entryOrdinal: number }
    | undefined;
  #lastRecordOrdinal: number | undefined;
  #finished = false;

  constructor(options: CodexRolloutNormalizationOptions) {
    if (options.logicalLocator.length === 0 || !options.logicalLocator.isWellFormed()) {
      throw new TypeError("Codex logical locator must be non-empty and well-formed");
    }
    this.#options = options;
    this.#lineage = new CodexLineageTracker(options.identity, options.stateParentNativeId);
  }

  addRecord(value: unknown, recordOrdinal: number): void {
    if (this.#finished) throw new TypeError("Codex rollout normalizer is already finished");
    if (!Number.isSafeInteger(recordOrdinal) || recordOrdinal < 0) throwMalformed();
    if (this.#lastRecordOrdinal !== undefined && recordOrdinal !== this.#lastRecordOrdinal + 1) {
      this.#previousMessage = undefined;
    }
    this.#lastRecordOrdinal = recordOrdinal;

    const parsed = this.#parseOuter(value, recordOrdinal);
    if (parsed.messageFamily === undefined) {
      for (const draft of parsed.entries) this.#append(draft);
      this.#previousMessage = undefined;
      return;
    }

    const draft = parsed.entries[0];
    if (draft === undefined || parsed.entries.length !== 1) throwMalformed();
    this.#appendMessage(draft, parsed.messageFamily);
  }

  breakAdjacency(): void {
    if (this.#finished) throw new TypeError("Codex rollout normalizer is already finished");
    this.#previousMessage = undefined;
  }

  finish(): SessionDocument {
    if (this.#finished) throw new TypeError("Codex rollout normalizer is already finished");
    this.#finished = true;
    const relations = this.#lineage.finish();

    for (const [id, resultOrdinal] of this.#toolResults) {
      const callOrdinal = this.#toolCalls.get(id);
      if (callOrdinal !== undefined)
        this.#entries[resultOrdinal]!.relatedEntryOrdinal = callOrdinal;
    }
    for (const [id, terminalOrdinals] of this.#turnTerminals) {
      const starts = this.#turnStarts.get(id);
      if (starts?.length !== 1) continue;
      for (const terminalOrdinal of terminalOrdinals) {
        this.#entries[terminalOrdinal]!.relatedEntryOrdinal = starts[0]!;
      }
    }

    return {
      identity: this.#options.identity,
      ...(this.#options.title === undefined ? {} : { title: this.#options.title }),
      ...(this.#options.workspace === undefined ? {} : { workspace: this.#options.workspace }),
      ...(this.#options.createdAt === undefined ? {} : { createdAt: this.#options.createdAt }),
      ...(this.#options.updatedAt === undefined ? {} : { updatedAt: this.#options.updatedAt }),
      relations,
      entries: this.#entries,
    };
  }

  #parseOuter(value: unknown, recordOrdinal: number): ParsedRecord {
    const outer = plainRecord(value);
    const outerType = discriminator(outer, "type");
    const payload = requiredRecord(outer, "payload");
    const timestamp = timestampField(outer);

    switch (outerType) {
      case "session_meta":
        return { entries: this.#sessionMeta(payload, timestamp, recordOrdinal) };
      case "turn_context":
        return { entries: turnContext(payload, timestamp, recordOrdinal) };
      case "response_item":
        return responseItem(payload, timestamp, recordOrdinal);
      case "event_msg":
        return eventMessage(payload, timestamp, recordOrdinal);
      case "inter_agent_communication":
        return { entries: [interAgentCommunication(payload, timestamp, recordOrdinal)] };
      case "compacted":
        return { entries: compacted(payload, timestamp, recordOrdinal) };
      case "inter_agent_communication_metadata":
      case "world_state":
        return { entries: [] };
      default:
        return { entries: [unknownEntry(outerType, timestamp, recordOrdinal)] };
    }
  }

  #sessionMeta(
    payload: UnknownRecord,
    timestamp: string | undefined,
    recordOrdinal: number,
  ): readonly EntryDraft[] {
    const id = requiredText(payload, "id", true);
    const sessionId = optionalText(payload, "session_id", true);
    if (sessionId !== undefined && sessionId !== id) throwMalformed();
    const parentThreadId = optionalText(payload, "parent_thread_id", true);
    const forkedFromId = optionalText(payload, "forked_from_id", true);
    const baseInstructions = optionalRecord(payload, "base_instructions");
    const baseText =
      baseInstructions === undefined ? undefined : requiredText(baseInstructions, "text");

    if (id !== this.#options.identity.nativeId) return [];
    this.#lineage.observeCurrentMetadata({
      ...(parentThreadId === undefined ? {} : { parentThreadId }),
      ...(forkedFromId === undefined ? {} : { forkedFromId }),
    });
    if (baseText === undefined) return [];
    return [
      entry("injected-context", INJECTED, [text(baseText, INJECTED)], timestamp, recordOrdinal),
    ];
  }

  #appendMessage(draft: EntryDraft, family: "event" | "response"): void {
    const candidate = materializeEntry(draft, this.#entries.length, this.#options.logicalLocator);
    const previous = this.#previousMessage;
    if (
      previous !== undefined &&
      previous.family !== family &&
      sameMessage(this.#entries[previous.entryOrdinal]!, candidate)
    ) {
      // The response representation is authoritative regardless of record order.
      if (family === "response") {
        candidate.ordinal = previous.entryOrdinal;
        this.#entries[previous.entryOrdinal] = candidate;
      }
      this.#previousMessage = { family: "response", entryOrdinal: previous.entryOrdinal };
      return;
    }

    const ordinal = this.#entries.length;
    this.#entries.push(candidate);
    this.#previousMessage = { family, entryOrdinal: ordinal };
  }

  #append(draft: EntryDraft): void {
    const ordinal = this.#entries.length;
    if (draft.link?.kind === "tool-call") {
      if (this.#toolCalls.has(draft.link.id)) throwMalformed();
      this.#toolCalls.set(draft.link.id, ordinal);
    } else if (draft.link?.kind === "tool-result") {
      if (this.#toolResults.has(draft.link.id)) throwMalformed();
      this.#toolResults.set(draft.link.id, ordinal);
    } else if (draft.link?.kind === "turn-start") {
      appendOrdinal(this.#turnStarts, draft.link.id, ordinal);
    } else if (draft.link?.kind === "turn-terminal") {
      appendOrdinal(this.#turnTerminals, draft.link.id, ordinal);
    }
    this.#entries.push(materializeEntry(draft, ordinal, this.#options.logicalLocator));
  }
}

function materializeEntry(
  draft: EntryDraft,
  ordinal: number,
  logicalLocator: string,
): MutableEntry {
  return {
    ordinal,
    kind: draft.kind,
    actor: draft.actor,
    ...(draft.timestamp === undefined ? {} : { timestamp: draft.timestamp }),
    ...(draft.toolCallId === undefined ? {} : { toolCallId: draft.toolCallId }),
    ...(draft.toolName === undefined ? {} : { toolName: draft.toolName }),
    ...(draft.toolNamespace === undefined ? {} : { toolNamespace: draft.toolNamespace }),
    sourceLocator: { uri: logicalLocator, recordId: String(draft.recordOrdinal) },
    content: draft.content.map((segment, segmentOrdinal) =>
      segment.kind === "text"
        ? {
            kind: "text",
            ordinal: segmentOrdinal,
            text: segment.text,
            contentHash: hashContent(segment.text),
            origin: segment.origin,
            originConfidence: segment.confidence,
            sourceMetadata: {},
          }
        : {
            kind: "omitted",
            ordinal: segmentOrdinal,
            contentClass: segment.contentClass,
            sourceType: segment.sourceType,
            origin: segment.origin,
            originConfidence: segment.confidence,
            sourceMetadata: {},
          },
    ),
  };
}

function sameMessage(left: SessionEntry, right: SessionEntry): boolean {
  if (
    left.kind !== "message" ||
    right.kind !== "message" ||
    left.actor !== right.actor ||
    left.timestamp !== right.timestamp ||
    left.content.length !== right.content.length
  ) {
    return false;
  }
  return left.content.every((segment, index) => {
    const other = right.content[index];
    if (
      other === undefined ||
      segment.kind !== other.kind ||
      segment.origin !== other.origin ||
      segment.originConfidence !== other.originConfidence
    ) {
      return false;
    }
    return segment.kind === "text"
      ? other.kind === "text" && segment.text === other.text
      : other.kind === "omitted" &&
          segment.contentClass === other.contentClass &&
          segment.sourceType === other.sourceType;
  });
}

function appendOrdinal(map: Map<string, number[]>, id: string, ordinal: number): void {
  const values = map.get(id);
  if (values === undefined) map.set(id, [ordinal]);
  else values.push(ordinal);
}
