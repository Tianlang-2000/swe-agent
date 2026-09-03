import type { z } from 'zod';
import type OpenAI from 'openai';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: Role;
  /** For assistant: text content. For tool: tool result payload. */
  /** assistant 消息：纯文本内容。tool 消息：工具返回的结果载荷。 */
  content: string;
  /** Set on assistant messages that produced tool calls. */
  /** 仅在 assistant 消息产生了 tool_calls 时设置。 */
  tool_calls?: ToolCall[];
  /** For tool messages: which call this is a result for. */
  /** tool 消息：表示这是哪一次调用的结果。 */
  tool_call_id?: string;
  /** For assistant messages: name (optional, used in multi-agent scenarios). */
  /** assistant 消息：可选的名称，多 agent 场景下使用。 */
  name?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Already parsed JSON object (or string if model emitted raw). */
  /** 已解析的 JSON 对象（如果模型直接吐字符串则保持 string）。 */
  arguments: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** Zod schema for the tool's input. Converted to JSON schema for the API. */
  /** 工具入参的 Zod schema，会被转换为 JSON schema 发给 API。 */
  schema: z.ZodTypeAny;
}

export interface ToolContext {
  workdir: string;
  timeoutMs: number;
  maxOutputChars: number;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  /** When ok=false, a short error tag for the LLM. */
  /** ok=false 时，给 LLM 看的简短错误标签。 */
  error?: string;
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

/** A registered tool, ready to be sent to the LLM and invoked. */
/** 一个已注册的工具，已准备好发给 LLM 并被调用。 */
export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

export type OpenAITool = OpenAI.Chat.ChatCompletionTool;
export type OpenAIToolCall = OpenAI.Chat.ChatCompletionMessageToolCall;
