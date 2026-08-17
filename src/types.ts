import type { z } from 'zod';
import type OpenAI from 'openai';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: Role;
  /** For assistant: text content. For tool: tool result payload. */
  content: string;
  /** Set on assistant messages that produced tool calls. */
  tool_calls?: ToolCall[];
  /** For tool messages: which call this is a result for. */
  tool_call_id?: string;
  /** For assistant messages: name (optional, used in multi-agent scenarios). */
  name?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Already parsed JSON object (or string if model emitted raw). */
  arguments: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** Zod schema for the tool's input. Converted to JSON schema for the API. */
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
  error?: string;
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

/** A registered tool, ready to be sent to the LLM and invoked. */
export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

export type OpenAITool = OpenAI.Chat.ChatCompletionTool;
export type OpenAIToolCall = OpenAI.Chat.ChatCompletionMessageToolCall;
