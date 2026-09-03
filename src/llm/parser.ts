import type { ChatResponse } from './client.js';
import type { ToolCall } from '../types.js';

/**
 * Pull structured tool calls out of a chat response. The OpenAI SDK already
 * gives us typed tool_calls, so this is mostly defensive — it guards against
 * empty / malformed IDs and name collisions.
 */
/**
 * 从聊天响应中抽取结构化的 tool calls。OpenAI SDK 已经给了带类型的 tool_calls，
 * 所以这里主要是防御性的——防止 id 为空、name 缺失或冲突。
 */
export function parseToolCalls(resp: ChatResponse): ToolCall[] {
  return resp.toolCalls.filter((tc: ToolCall) => Boolean(tc.id) && Boolean(tc.name));
}

/**
 * Coalesce an assistant turn into a single human-readable text block. Useful
 * for logging and for cases where we want to feed the latest assistant text
 * back into the prompt.
 */
/**
 * 把一轮 assistant 消息合并成一段可读的文本。便于日志输出，
 * 以及把最近一轮 assistant 文本重新塞回 prompt 的场景。
 */
export function summariseAssistantTurn(resp: ChatResponse): string {
  if (resp.content && resp.toolCalls.length > 0) return resp.content;
  if (resp.content) return resp.content;
  if (resp.toolCalls.length > 0) {
    return `[no text, ${resp.toolCalls.length} tool call(s): ${resp.toolCalls.map((t: ToolCall) => t.name).join(', ')}]`;
  }
  return '[empty assistant turn]';
}
