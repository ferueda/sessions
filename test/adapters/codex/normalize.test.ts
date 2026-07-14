import { describe, expect, test } from "vitest";

import {
  DEFERRED_EVENT_TYPES,
  DEFERRED_RESPONSE_TYPES,
  SKIPPED_EVENT_TYPES,
} from "../../../src/adapters/codex/format-support.ts";
import {
  createCodexRolloutNormalizer,
  type CodexRolloutNormalizationOptions,
} from "../../../src/adapters/codex/normalize.ts";
import { CodexRolloutError } from "../../../src/adapters/codex/rollout.ts";
import { validateSessionDocument } from "../../../src/domain/session-validation.ts";
import type { ContentSegment, SessionDocument, SessionEntry } from "../../../src/domain/session.ts";

const IDENTITY = {
  source: { kind: "codex", instanceId: "local-sha256-v1:fixture" },
  nativeId: "thread-current",
} as const;
const OPTIONS: CodexRolloutNormalizationOptions = {
  identity: IDENTITY,
  logicalLocator: "codex-rollout://thread-current",
  spawnEdgeCoverage: "unknown",
};

const DEFERRED_RESPONSES = [
  "additional_tools",
  "local_shell_call",
  "tool_search_call",
  "tool_search_output",
  "web_search_call",
  "image_generation_call",
] as const;

const DEFERRED_EVENTS = [
  "mcp_tool_call_begin",
  "mcp_tool_call_end",
  "web_search_begin",
  "web_search_end",
  "image_generation_begin",
  "image_generation_end",
  "exec_command_begin",
  "exec_command_end",
  "view_image_tool_call",
  "dynamic_tool_call_request",
  "dynamic_tool_call_response",
  "patch_apply_begin",
  "patch_apply_end",
  "entered_review_mode",
  "exited_review_mode",
  "item_completed",
  "collab_agent_spawn_begin",
  "collab_agent_spawn_end",
  "collab_agent_interaction_begin",
  "collab_agent_interaction_end",
  "collab_waiting_begin",
  "collab_waiting_end",
  "collab_close_begin",
  "collab_close_end",
  "collab_resume_begin",
  "collab_resume_end",
  "sub_agent_activity",
] as const;

const SKIPPED_EVENTS = [
  "realtime_conversation_started",
  "realtime_conversation_realtime",
  "realtime_conversation_closed",
  "realtime_conversation_sdp",
  "model_reroute",
  "model_verification",
  "turn_moderation_metadata",
  "safety_buffering",
  "thread_settings_applied",
  "token_count",
  "agent_reasoning_raw_content",
  "agent_reasoning_section_break",
  "session_configured",
  "thread_goal_updated",
  "mcp_startup_update",
  "mcp_startup_complete",
  "exec_command_output_delta",
  "terminal_interaction",
  "exec_approval_request",
  "request_permissions",
  "request_user_input",
  "elicitation_request",
  "apply_patch_approval_request",
  "guardian_assessment",
  "patch_apply_updated",
  "turn_diff",
  "realtime_conversation_list_voices_response",
  "plan_update",
  "shutdown_complete",
  "raw_response_item",
  "raw_response_completed",
  "item_started",
  "hook_started",
  "hook_completed",
  "agent_message_content_delta",
  "plan_delta",
  "reasoning_content_delta",
  "reasoning_raw_content_delta",
] as const;

describe("Codex rollout normalization", () => {
  test("retains current metadata, ordered instructions, timestamps, and explicit lineage", () => {
    const document = normalize(
      [
        sessionMeta({
          session_id: IDENTITY.nativeId,
          parent_thread_id: "thread-parent",
          forked_from_id: "thread-parent",
          base_instructions: { text: "base" },
        }),
        sessionMeta(
          {
            id: "thread-replayed",
            session_id: "thread-replayed",
            parent_thread_id: "ignored-parent",
            base_instructions: { text: "ignored replay" },
          },
          "2026-07-14T01:02:03Z",
        ),
        outer(
          "turn_context",
          {
            turn_id: "turn-1",
            user_instructions: "user constraints",
            developer_instructions: "developer constraints",
          },
          "2026-07-13T18:02:03.456-07:00",
        ),
      ],
      {
        title: "A title",
        workspace: "/workspace",
        createdAt: "2026-07-13T01:00:00.000Z",
        updatedAt: "2026-07-14T01:00:00.000Z",
      },
    );

    expect(document).toMatchObject({
      identity: IDENTITY,
      title: "A title",
      workspace: "/workspace",
      createdAt: "2026-07-13T01:00:00.000Z",
      updatedAt: "2026-07-14T01:00:00.000Z",
      lineageCoverage: "unknown",
      relations: [
        {
          kind: "parent",
          target: { source: IDENTITY.source, nativeId: "thread-parent" },
          confidence: "high",
        },
      ],
    });
    expect(document.entries.map((entry) => entry.kind)).toEqual([
      "injected-context",
      "injected-context",
      "injected-context",
    ]);
    expect(allText(document)).toEqual(["base", "user constraints", "developer constraints"]);
    expect(document.entries.map((entry) => entry.timestamp)).toEqual([
      undefined,
      "2026-07-14T01:02:03.456Z",
      "2026-07-14T01:02:03.456Z",
    ]);
    expect(document.entries.map((entry) => entry.sourceLocator)).toEqual([
      { uri: OPTIONS.logicalLocator, recordId: "0" },
      { uri: OPTIONS.logicalLocator, recordId: "2" },
      { uri: OPTIONS.logicalLocator, recordId: "2" },
    ]);
    expect(validateSessionDocument(document)).toMatchObject({ ok: true });
  });

  test("uses a state edge as authoritative lineage and collapses matching metadata", () => {
    const document = normalize(
      [
        sessionMeta({ parent_thread_id: "state-parent" }),
        sessionMeta({ forked_from_id: "state-parent" }),
      ],
      { spawnEdgeCoverage: "complete", stateParentNativeId: "state-parent" },
    );

    expect(document).toMatchObject({
      lineageCoverage: "complete",
      relations: [
        {
          kind: "parent",
          target: { source: IDENTITY.source, nativeId: "state-parent" },
          confidence: "high",
        },
      ],
    });
  });

  test("distinguishes complete row absence from unknown table coverage", () => {
    const unknown = normalize([sessionMeta({ parent_thread_id: "metadata-parent" })]);
    const complete = normalize([sessionMeta({ parent_thread_id: "metadata-parent" })], {
      spawnEdgeCoverage: "complete",
    });
    const completeRoot = normalize([sessionMeta()], { spawnEdgeCoverage: "complete" });

    expect(unknown).toMatchObject({ lineageCoverage: "unknown" });
    expect(complete).toMatchObject({
      lineageCoverage: "complete",
      relations: [{ kind: "parent", target: { nativeId: "metadata-parent" } }],
    });
    expect(completeRoot).toMatchObject({ lineageCoverage: "complete", relations: [] });
  });

  test("rejects missing or conflicting current metadata without leaking values", () => {
    const noCurrent = createCodexRolloutNormalizer(OPTIONS);
    noCurrent.addRecord(sessionMeta({ id: "replayed" }), 0);
    expect(() => noCurrent.finish()).toThrowError(CodexRolloutError);

    expectMalformedSequence([
      sessionMeta({ parent_thread_id: "left" }),
      sessionMeta({ forked_from_id: "right" }),
    ]);
    expectMalformedSequence([sessionMeta({ parent_thread_id: "metadata-parent" })], {
      spawnEdgeCoverage: "complete",
      stateParentNativeId: "state-parent",
    });
    expectMalformedSequence([sessionMeta({ parent_thread_id: "state-parent" })], {
      spawnEdgeCoverage: "unknown",
      stateParentNativeId: "state-parent",
    });
    expectMalformedSequence([sessionMeta({ session_id: "different" })]);
    expectMalformedSequence([sessionMeta({ parent_thread_id: IDENTITY.nativeId })]);
  });

  test("normalizes all message roles and nested message content", () => {
    const document = normalize([
      sessionMeta(),
      response({
        type: "message",
        role: "user",
        phase: "commentary",
        content: [
          { type: "input_text", text: "hello" },
          { type: "input_image", image_url: "https://example.invalid/a", detail: "high" },
          { type: "future_item", secret: "discarded" },
        ],
      }),
      response({
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "answer" }],
      }),
      response({
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "developer" }],
      }),
      response({
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: "system" }],
      }),
    ]);

    expect(document.entries.map(({ actor }) => actor)).toEqual([
      "human",
      "model",
      "system",
      "system",
    ]);
    expect(segmentSummary(document.entries[0]!)).toEqual([
      "text:hello:human:high",
      "omitted:image:input-image:human:high",
      "omitted:unknown:unknown-content-item:human:high",
    ]);
    expect(document.entries[2]?.content[0]).toMatchObject({
      origin: "injected",
      originConfidence: "high",
    });
    expect(document.entries[3]?.content[0]).toMatchObject({
      origin: "system",
      originConfidence: "high",
    });
  });

  test("preserves visible delegated/reasoning text and emits opaque omissions in order", () => {
    const document = normalize([
      sessionMeta(),
      response({
        type: "agent_message",
        author: "agent-a",
        recipient: "agent-b",
        content: [
          { type: "input_text", text: "delegated" },
          { type: "encrypted_content", encrypted_content: "ciphertext" },
          { type: "future_agent_item", private: "discarded" },
        ],
      }),
      response({
        type: "reasoning",
        summary: [
          { type: "summary_text", text: "visible summary" },
          { type: "future_summary", text: "must not copy" },
        ],
        content: [
          { type: "reasoning_text", text: "hidden reasoning" },
          { type: "text", text: "also hidden" },
          { type: "future_reasoning", secret: "discarded" },
        ],
        encrypted_content: "ciphertext",
      }),
      outer("inter_agent_communication", {
        author: "agent-a",
        recipient: "agent-b",
        content: "outer delegated",
        encrypted_content: "ciphertext",
      }),
    ]);

    expect(segmentSummary(document.entries[0]!)).toEqual([
      "text:delegated:delegated:high",
      "omitted:unknown:encrypted-agent-content:delegated:high",
      "omitted:unknown:unknown-content-item:delegated:high",
    ]);
    expect(segmentSummary(document.entries[1]!)).toEqual([
      "text:visible summary:model:high",
      "omitted:unknown:unknown-content-item:model:high",
      "omitted:unknown:reasoning-content:model:high",
      "omitted:unknown:reasoning-content:model:high",
      "omitted:unknown:unknown-content-item:model:high",
      "omitted:unknown:encrypted-reasoning:model:high",
    ]);
    expect(segmentSummary(document.entries[2]!)).toEqual([
      "text:outer delegated:delegated:high",
      "omitted:unknown:encrypted-agent-content:delegated:high",
    ]);
    expect(JSON.stringify(document)).not.toContain("hidden reasoning");
    expect(JSON.stringify(document)).not.toContain("ciphertext");
    expect(JSON.stringify(document)).not.toContain("must not copy");
  });

  test("links namespaced calls and ordered results across the complete rollout", () => {
    const document = normalize([
      sessionMeta(),
      response({
        type: "function_call_output",
        call_id: "call-1",
        output: [
          { type: "input_text", text: "result" },
          { type: "input_image", image_url: "https://example.invalid/image" },
          { type: "encrypted_content", encrypted_content: "ciphertext" },
          { type: "future_result", value: "discarded" },
        ],
      }),
      event({ type: "token_count", call_id: "call-1" }),
      response({
        type: "function_call",
        call_id: "call-1",
        name: "lookup",
        namespace: "catalog",
        arguments: "{}",
      }),
      response({
        type: "custom_tool_call",
        call_id: "call-2",
        name: "custom",
        input: "",
      }),
      response({
        type: "custom_tool_call_output",
        call_id: "call-2",
        name: 42,
        output: "",
      }),
    ]);

    const [result, call, customCall, customResult] = document.entries;
    expect(result).toMatchObject({
      kind: "tool-result",
      actor: "tool",
      toolCallId: "call-1",
      relatedEntryOrdinal: 1,
    });
    expect(result).not.toHaveProperty("toolName");
    expect(segmentSummary(result!)).toEqual([
      "text:result:tool:high",
      "omitted:image:input-image:tool:high",
      "omitted:unknown:encrypted-tool-content:tool:high",
      "omitted:structured:unknown-content-item:tool:high",
    ]);
    expect(call).toMatchObject({
      kind: "tool-call",
      toolCallId: "call-1",
      toolName: "lookup",
      toolNamespace: "catalog",
    });
    expect(customCall?.content[0]).toMatchObject({ kind: "text", text: "" });
    expect(customResult).toMatchObject({
      kind: "tool-result",
      toolCallId: "call-2",
      relatedEntryOrdinal: 2,
    });
    expect(customResult?.content[0]).toMatchObject({ kind: "text", text: "" });
    expect(validateSessionDocument(document)).toMatchObject({ ok: true });
  });

  test("keeps unmatched tools unlinked and rejects duplicate call/result IDs", () => {
    const document = normalize([
      sessionMeta(),
      response({
        type: "function_call",
        call_id: "call-only",
        name: "tool",
        arguments: "args",
      }),
      response({ type: "function_call_output", call_id: "result-only", output: [] }),
    ]);

    expect(document.entries[0]).not.toHaveProperty("relatedEntryOrdinal");
    expect(document.entries[1]).not.toHaveProperty("relatedEntryOrdinal");
    expect(document.entries[1]?.content).toEqual([]);

    expectMalformedSequence([
      sessionMeta(),
      response({ type: "function_call", call_id: "same", name: "a", arguments: "" }),
      response({ type: "custom_tool_call", call_id: "same", name: "b", input: "" }),
    ]);
    expectMalformedSequence([
      sessionMeta(),
      response({ type: "function_call_output", call_id: "same", output: "a" }),
      response({ type: "custom_tool_call_output", call_id: "same", output: "b" }),
    ]);
  });

  test.each(["compaction", "compaction_summary"])("normalizes %s encrypted compaction", (type) => {
    const document = normalize([
      sessionMeta(),
      response({ type, encrypted_content: "ciphertext" }),
    ]);
    expect(segmentSummary(document.entries[0]!)).toEqual([
      "omitted:unknown:encrypted-compaction:system:high",
    ]);
    expect(JSON.stringify(document)).not.toContain("ciphertext");
  });

  test("preserves every compaction representation and ordered compacted context", () => {
    const document = normalize([
      sessionMeta(),
      response({ type: "context_compaction", encrypted_content: "ciphertext" }),
      response({ type: "context_compaction" }),
      outer("compacted", { message: "compacted context" }),
      event({ type: "context_compacted" }),
      response({ type: "compaction_trigger", private: "ignored" }),
    ]);

    expect(document.entries.map(({ kind }) => kind)).toEqual([
      "compaction",
      "compaction",
      "compaction",
      "injected-context",
      "compaction",
    ]);
    expect(allText(document)).toEqual(["compacted context"]);
  });

  test("normalizes event messages, images, reasoning, rollback, and diagnostics", () => {
    const document = normalize([
      sessionMeta(),
      event({
        type: "user_message",
        message: "question",
        images: ["https://example.invalid/one", "https://example.invalid/two"],
        local_images: ["/private/image"],
      }),
      event({ type: "agent_message", message: "answer" }),
      event({ type: "agent_reasoning", text: "visible reasoning" }),
      event({ type: "thread_rolled_back", num_turns: 0 }),
      event({ type: "warning", message: "warning" }),
      event({ type: "guardian_warning", message: "guardian" }),
      event({ type: "error", message: "error" }),
      event({ type: "stream_error", message: "stream", additional_details: "details" }),
      event({ type: "deprecation_notice", summary: "deprecated", details: "migration" }),
    ]);

    expect(segmentSummary(document.entries[0]!)).toEqual([
      "text:question:human:high",
      "omitted:image:input-image:human:high",
      "omitted:image:input-image:human:high",
      "omitted:image:local-image:human:high",
    ]);
    expect(document.entries.map(({ kind }) => kind)).toEqual([
      "message",
      "message",
      "reasoning-summary",
      "rollback",
      "diagnostic",
      "diagnostic",
      "diagnostic",
      "diagnostic",
      "diagnostic",
    ]);
    expect(allText(document)).toEqual([
      "question",
      "answer",
      "visible reasoning",
      "warning",
      "guardian",
      "error",
      "stream",
      "details",
      "deprecated",
      "migration",
    ]);
    expect(JSON.stringify(document)).not.toContain("/private/image");
  });

  test.each([
    ["task_started", "task_complete"],
    ["turn_started", "turn_complete"],
  ] as const)("links %s to %s only by exact turn ID", (started, completed) => {
    const document = normalize([
      sessionMeta(),
      event({ type: completed, turn_id: "turn-future", error: null }),
      event({ type: started, turn_id: "turn-future" }),
      event({ type: "turn_aborted", turn_id: "turn-future", reason: "interrupted" }),
      event({
        type: "turn_complete",
        turn_id: "other-turn",
        error: { message: "diagnostic only" },
      }),
      event({ type: "turn_aborted", turn_id: null, reason: "replaced" }),
    ]);

    expect(document.entries.map(({ kind }) => kind)).toEqual([
      "turn-completed",
      "turn-started",
      "turn-aborted",
      "turn-completed",
      "diagnostic",
      "turn-aborted",
    ]);
    expect(document.entries[0]?.relatedEntryOrdinal).toBe(1);
    expect(document.entries[2]?.relatedEntryOrdinal).toBe(1);
    expect(document.entries[3]).not.toHaveProperty("relatedEntryOrdinal");
    expect(document.entries[4]).not.toHaveProperty("relatedEntryOrdinal");
    expect(document.entries[5]).not.toHaveProperty("relatedEntryOrdinal");
  });

  test("deduplicates only adjacent exact cross-family messages and keeps response locators", () => {
    const responseRecord = response({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "same" }],
    });
    const eventRecord = event({ type: "user_message", message: "same", images: null });
    const document = normalize([
      sessionMeta(),
      eventRecord,
      responseRecord,
      responseRecord,
      eventRecord,
      event({ type: "token_count" }),
      eventRecord,
      response({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "different" }],
      }),
    ]);

    expect(document.entries.map((entry) => textOf(entry))).toEqual([
      "same",
      "same",
      "same",
      "different",
    ]);
    expect(document.entries.map(({ sourceLocator }) => sourceLocator.recordId)).toEqual([
      "2",
      "3",
      "6",
      "7",
    ]);
  });

  test("timestamp and omission differences prevent message deduplication", () => {
    const document = normalize([
      sessionMeta(),
      event({ type: "user_message", message: "same", images: ["one"] }, "2026-01-01T00:00:00Z"),
      response(
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "same" },
            { type: "input_image", image_url: "two" },
          ],
        },
        "2026-01-01T00:00:01Z",
      ),
    ]);
    expect(document.entries).toHaveLength(2);
  });

  test("explicit blank adjacency boundaries prevent deduplication", () => {
    const normalizer = createCodexRolloutNormalizer(OPTIONS);
    normalizer.addRecord(sessionMeta(), 0);
    normalizer.addRecord(event({ type: "agent_message", message: "same" }), 1);
    normalizer.breakAdjacency();
    normalizer.addRecord(
      response({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "same" }],
      }),
      2,
    );
    expect(normalizer.finish().entries).toHaveLength(2);
  });

  test("maps every exact deferred response discriminator to one safe omission", () => {
    expect([...DEFERRED_RESPONSE_TYPES]).toEqual(DEFERRED_RESPONSES);
    for (const type of DEFERRED_RESPONSES) {
      const document = normalize([sessionMeta(), response({ type, secret: "discarded" })]);
      expect(segmentSummary(document.entries[0]!)).toEqual([
        `omitted:unknown:${type.replaceAll("_", "-")}:unknown:unknown`,
      ]);
      expect(JSON.stringify(document)).not.toContain("discarded");
    }
  });

  test("maps every exact deferred event discriminator to one safe omission", () => {
    expect([...DEFERRED_EVENT_TYPES]).toEqual(DEFERRED_EVENTS);
    for (const type of DEFERRED_EVENTS) {
      const document = normalize([sessionMeta(), event({ type, secret: "discarded" })]);
      expect(segmentSummary(document.entries[0]!)).toEqual([
        `omitted:unknown:${type.replaceAll("_", "-")}:unknown:unknown`,
      ]);
      expect(JSON.stringify(document)).not.toContain("discarded");
    }
  });

  test("keeps the exact known-skip event set non-canonical", () => {
    expect([...SKIPPED_EVENT_TYPES]).toEqual(SKIPPED_EVENTS);
    for (const type of SKIPPED_EVENTS) {
      const document = normalize([sessionMeta(), event({ type, private: "discarded" })]);
      expect(document.entries).toEqual([]);
    }
  });

  test("skips outer metadata/world state without inspecting provider fields", () => {
    let getterCalls = 0;
    const skippedEvent = { type: "token_count" } as Record<string, unknown>;
    Object.defineProperty(skippedEvent, "private", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must not inspect";
      },
    });
    const document = normalize([
      sessionMeta(),
      outer("inter_agent_communication_metadata", { trigger_turn: Symbol("ignored") }),
      outer("world_state", { privateSnapshot: Symbol("ignored") }),
      event(skippedEvent),
    ]);
    expect(document.entries).toEqual([]);
    expect(getterCalls).toBe(0);
  });

  test.each([
    ["future_outer", "future-outer"],
    ["future-outer", "future-outer"],
    ["../../private/path", "unknown-record"],
    ["UPPER_CASE", "unknown-record"],
    ["double__separator", "unknown-record"],
    ["unicode_é", "unknown-record"],
    ["control_\u0001", "unknown-record"],
    [`oversized_${"a".repeat(70)}`, "unknown-record"],
  ])("sanitizes unknown outer discriminator %j", (type, sourceType) => {
    const document = normalize([sessionMeta(), outer(type, { secret: "discarded" })]);
    expect(document.entries[0]).toMatchObject({ kind: "unknown", actor: "unknown" });
    expect(document.entries[0]?.content[0]).toMatchObject({
      kind: "omitted",
      contentClass: "unknown",
      sourceType,
      origin: "unknown",
      originConfidence: "unknown",
    });
    const serialized = JSON.stringify(document);
    expect(serialized).not.toContain("discarded");
    expect(sourceType !== "unknown-record" || !serialized.includes(type)).toBe(true);
  });

  test("uses payload discriminators for unknown response and event records", () => {
    const document = normalize([
      sessionMeta(),
      response({ type: "future_response", secret: "discarded" }),
      event({ type: "future_event", secret: "discarded" }),
    ]);
    expect(document.entries.map((item) => omittedOf(item)?.sourceType)).toEqual([
      "future-response",
      "future-event",
    ]);
  });

  test("emits fixed unknown nested tokens without inspecting unknown fields", () => {
    const document = normalize([
      sessionMeta(),
      response({
        type: "message",
        role: "assistant",
        content: [{ type: "../../path", secret: "discarded" }],
      }),
      response({
        type: "function_call_output",
        call_id: "call",
        output: [{ type: "future_output", secret: "discarded" }],
      }),
    ]);
    expect(document.entries.map((item) => omittedOf(item))).toMatchObject([
      { contentClass: "unknown", sourceType: "unknown-content-item" },
      { contentClass: "structured", sourceType: "unknown-content-item" },
    ]);
  });

  test.each([
    outer("response_item", { role: "user", content: [] }),
    outer("response_item", { type: "", role: "user", content: [] }),
    outer("event_msg", { type: "user_message", message: 42 }),
    response({ type: "message", role: "tool", content: [] }),
    response({ type: "message", role: "assistant", phase: "analysis", content: [] }),
    response({ type: "message", role: "assistant", content: {} }),
    response({
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: "url", detail: "full" }],
    }),
    response({ type: "function_call", call_id: "", name: "tool", arguments: "" }),
    response({ type: "function_call_output", call_id: "call", output: 42 }),
    response({ type: "reasoning", summary: {}, content: [] }),
    event({ type: "user_message", message: "text", local_images: null }),
    event({ type: "turn_aborted", reason: "success" }),
    event({ type: "thread_rolled_back", num_turns: 4_294_967_296 }),
    event({ type: "task_complete", turn_id: "turn", error: {} }),
  ])("rejects malformed recognized record %# without provider details", (record) => {
    expect.hasAssertions();
    expectMalformedSequence([sessionMeta(), record]);
  });

  test.each([
    "2026-02-30T00:00:00Z",
    "2026-01-01 00:00:00Z",
    "2026-01-01T00:00:00",
    "2026-01-01T24:00:00Z",
    "not-a-timestamp",
  ])("rejects non-RFC3339 timestamp %s", (timestamp) => {
    expect.hasAssertions();
    expectMalformedSequence([sessionMeta({}, timestamp)]);
  });

  test("does not invoke accessor properties at the rollout boundary", () => {
    let getterCalls = 0;
    const value = { type: "session_meta" } as Record<string, unknown>;
    Object.defineProperty(value, "payload", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { id: IDENTITY.nativeId };
      },
    });

    const normalizer = createCodexRolloutNormalizer(OPTIONS);
    expect(() => normalizer.addRecord(value, 0)).toThrowError(CodexRolloutError);
    expect(getterCalls).toBe(0);
  });
});

function normalize(
  records: readonly unknown[],
  overrides: Partial<CodexRolloutNormalizationOptions> = {},
): SessionDocument {
  const normalizer = createCodexRolloutNormalizer({ ...OPTIONS, ...overrides });
  records.forEach((record, ordinal) => normalizer.addRecord(record, ordinal));
  return normalizer.finish();
}

function expectMalformedSequence(
  records: readonly unknown[],
  overrides: Partial<CodexRolloutNormalizationOptions> = {},
): void {
  const error = (() => {
    try {
      normalize(records, overrides);
      return undefined;
    } catch (failure) {
      return failure;
    }
  })();
  expect(error).toBeInstanceOf(CodexRolloutError);
  expect(error).toMatchObject({
    kind: "malformed",
    message: "Codex rollout could not be read",
  });
  expect(JSON.stringify(error)).not.toContain("metadata-parent");
}

function sessionMeta(
  payload: Record<string, unknown> = {},
  timestamp?: string,
): Record<string, unknown> {
  return outer("session_meta", { id: IDENTITY.nativeId, ...payload }, timestamp);
}

function response(payload: Record<string, unknown>, timestamp?: string): Record<string, unknown> {
  return outer("response_item", payload, timestamp);
}

function event(payload: Record<string, unknown>, timestamp?: string): Record<string, unknown> {
  return outer("event_msg", payload, timestamp);
}

function outer(type: string, payload: unknown, timestamp?: string): Record<string, unknown> {
  return { type, payload, ...(timestamp === undefined ? {} : { timestamp }) };
}

function allText(document: SessionDocument): readonly string[] {
  return document.entries.flatMap((entry) =>
    entry.content.flatMap((segment) => (segment.kind === "text" ? [segment.text] : [])),
  );
}

function textOf(entry: SessionEntry): string | undefined {
  const segment = entry.content.find((item) => item.kind === "text");
  return segment?.kind === "text" ? segment.text : undefined;
}

function omittedOf(entry: SessionEntry): Extract<ContentSegment, { kind: "omitted" }> | undefined {
  const segment = entry.content.find((item) => item.kind === "omitted");
  return segment?.kind === "omitted" ? segment : undefined;
}

function segmentSummary(entry: SessionEntry): readonly string[] {
  return entry.content.map((segment) =>
    segment.kind === "text"
      ? `text:${segment.text}:${segment.origin}:${segment.originConfidence}`
      : `omitted:${segment.contentClass}:${segment.sourceType}:${segment.origin}:${segment.originConfidence}`,
  );
}
