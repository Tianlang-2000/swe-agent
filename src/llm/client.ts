import OpenAI from 'openai';
import type { AgentConfig } from '../config.js';
import type { ChatMessage, OpenAITool } from '../types.js';

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  tools?: OpenAITool[];
  maxTokens?: number;
}
export interface ChatResponse {
  /** Plain assistant text (may be empty if only tool calls). */
  /** 助手纯文本回复（如果只有 tool calls，可能为空）。 */
  content: string;
  /** Tool calls the assistant wants to execute. */
  /** 助手希望执行的工具调用列表。 */
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  /** Raw finish_reason from the provider (e.g. "stop", "tool_calls", "length"). */
  /** provider 返回的原始 finish_reason（如 "stop"、"tool_calls"、"length"）。 */
  finishReason: string | null;
  /** Token accounting (provider-dependent; may be 0 if not reported). */
  /** token 用量统计（依赖 provider，不上报时可能为 0）。 */
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export class LLMClient {
  private client: OpenAI;
  private model: string;
  private providerLabel: string;

  constructor(private cfg: AgentConfig) {
    this.client = new OpenAI({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL,
    });
    this.model = cfg.model;
    this.providerLabel = cfg.provider;
  }

  describe(): string {
    return `${this.providerLabel} :: ${this.model} @ ${this.cfg.baseURL}`;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: req.system },
      ...req.messages.map((m) => this.toOpenAIMessage(m)),
    ];

    const body: OpenAI.Chat.ChatCompletionCreateParams = {
      model: this.model,
      messages: openaiMessages,
      tools: req.tools,
      // Let the model decide when to stop vs emit tool calls.
      // 让模型自己决定什么时候停、什么时候发 tool call。
      tool_choice: 'auto',
    };

    // Most OpenAI-compatible APIs take `max_tokens`. We just pass it through;
    // unknown fields are ignored by strict providers.
    // 大多数 OpenAI 兼容 API 接受 `max_tokens` 字段。我们直接透传；
    // 严格的 provider 会忽略不认识的字段。
    if (req.maxTokens) {
      (body as unknown as Record<string, unknown>).max_tokens = req.maxTokens;
    }

    const resp = await this.client.chat.completions.create(body);
    const choice = resp.choices[0];
    const message = choice?.message;
    const content = message?.content ?? '';
    const rawCalls = message?.tool_calls ?? [];

    const toolCalls = rawCalls
      .filter((c) => c.type === 'function')
      .map((c) => {
        const fnCall = c as OpenAI.Chat.ChatCompletionMessageToolCall & { type: 'function' };
        let args: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(fnCall.function.arguments);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>;
          }
        } catch {
          // Keep args empty; the registry will surface an invalid_args error.
          // 保留 args 为空；registry 后续会报 invalid_args 错误。
        }
        return { id: fnCall.id, name: fnCall.function.name, arguments: args };
      });

    return {
      content,
      toolCalls,
      finishReason: choice?.finish_reason ?? null,
      usage: {
        promptTokens: resp.usage?.prompt_tokens ?? 0,
        completionTokens: resp.usage?.completion_tokens ?? 0,
        totalTokens: resp.usage?.total_tokens ?? 0,
      },
    };
  }

  private toOpenAIMessage(
    m: ChatMessage,
  ): OpenAI.Chat.ChatCompletionMessageParam {
    if (m.role === 'system') {
      // System messages are passed via the top-level `system` field, not as
      // a chat message. We should never see one here, but if we do, drop it
      // rather than send a malformed request.
      // system 消息通过顶层的 `system` 字段传入，而不是作为聊天消息。
      // 理论上这里不该出现 system 消息，万一出现了，就当作 user 处理，
      // 总比发一个格式错误的请求好。
      return { role: 'user', content: m.content };
    }
    if (m.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: m.tool_call_id ?? '',
        content: m.content,
      };
    }
    if (m.role === 'assistant') {
      // Convert our internal ToolCall shape (parsed args) into the OpenAI
      // wire shape (stringified args inside a `function` object).
      // 把我们内部的 ToolCall 形状（已解析的 args）转换为 OpenAI 线协议形状
      // （args 字符串化、塞进 `function` 对象里）。
      const wireCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = Array.isArray(m.tool_calls)
        ? m.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments ?? {}),
            },
          }))
        : [];
      return {
        role: 'assistant',
        content: m.content,
        ...(wireCalls.length > 0 ? { tool_calls: wireCalls } : {}),
      };
    }
    return { role: 'user', content: m.content };
  }
}
