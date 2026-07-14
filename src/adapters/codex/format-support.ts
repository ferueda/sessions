import { Buffer } from "node:buffer";

import { isCanonicalSourceType } from "../../domain/source-type.ts";

const STRUCTURAL_DISCRIMINATOR = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/u;

export const DEFERRED_RESPONSE_TYPES: ReadonlySet<string> = new Set([
  "additional_tools",
  "local_shell_call",
  "tool_search_call",
  "tool_search_output",
  "web_search_call",
  "image_generation_call",
]);

export const DEFERRED_EVENT_TYPES: ReadonlySet<string> = new Set([
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
]);

export const SKIPPED_EVENT_TYPES: ReadonlySet<string> = new Set([
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
]);

export function canonicalizeCodexDiscriminator(value: string): string {
  if (
    !value.isWellFormed() ||
    Buffer.byteLength(value, "utf8") > 64 ||
    !STRUCTURAL_DISCRIMINATOR.test(value)
  ) {
    return "unknown-record";
  }
  const canonical = value.replaceAll("_", "-");
  return isCanonicalSourceType(canonical) ? canonical : "unknown-record";
}
