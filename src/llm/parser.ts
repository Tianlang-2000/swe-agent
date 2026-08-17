import type { ChatResponse } from './client.js';
import type { ToolCall } from '../types.js';

/**
 * Pull structured tool calls out of a chat response. The OpenAI SDK already
 * gives us typed tool_calls, so this is mostly defensive — it guards against
 * empty / malformed IDs and name collisions.
 */
export function parseToolCalls(resp: ChatResponse): ToolCall[] {
  return resp.toolCalls.filter((tc: ToolCall) => Boolean(tc.id) && Boolean(tc.name));
}

/**
 * Coalesce an assistant turn into a single human-readable text block. Useful
 * for logging and for cases where we want to feed the latest assistant text
 * back into the prompt.
 */
export function summariseAssistantTurn(resp: ChatResponse): string {
  if (resp.content && resp.toolCalls.length > 0) return resp.content;
  if (resp.content) return resp.content;
  if (resp.toolCalls.length > 0) {
    return `[no text, ${resp.toolCalls.length} tool call(s): ${resp.toolCalls.map((t: ToolCall) => t.name).join(', ')}]`;
  }
  return '[empty assistant turn]';
}
