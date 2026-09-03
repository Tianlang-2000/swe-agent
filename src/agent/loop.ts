import type { AgentConfig } from '../config.js';
import type { LLMClient, ChatResponse } from '../llm/client.js';
import type { ToolRegistry } from '../tools/registry.js';
import { ToolRunner } from '../executor/runner.js';
import type { ChatMessage, ToolCall } from '../types.js';
import { PlanTracker } from './scheduler.js';
import { buildSystemPrompt, emptyHistory, userTurn, assistantTurn, toolResult } from './prompt.js';

export interface AgentOptions {
  config: AgentConfig;
  client: LLMClient;
  registry: ToolRegistry;
  // 每次assistant 生成回复时都会调用；适用于实时ui/日志记录
  // 每次 assistant 生成回复时都会调用；适用于实时 UI / 日志记录
  onAssistantTurn?: (resp: ChatResponse) => void;
  // 每次工具调用都会触发，并附带耗时和执行结果
  // 每次工具调用都会触发，并附带耗时和执行结果
  onToolResult?: (call: ToolCall, output: string, ok: boolean, durationMs: number) => void;
}

export interface AgentRunResult {
  final: string;
  steps: number;
  history: ChatMessage[];
  stoppedReason: 'finished' | 'max_steps' | 'error';
  totalUsage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/**
 * The main agent loop. This is the entire "thinking" of the system:
 *   observe → think → act → observe → ...
 *
 * The loop is intentionally single-threaded: each LLM call sees the full
 * history, and tool results are appended before the next LLM call. Streaming
 * is left out for simplicity; the chat API already returns everything we
 * need in one shot.
 */
/**
 * agent 主循环。整个系统的"思考"就这一段：
 *   观察 → 思考 → 行动 → 观察 → ...
 *
 * 循环故意是单线程的：每次 LLM 调用都看到完整 history，
 * tool 结果在下一次 LLM 调用前追加。为了简洁不做流式；
 * chat API 一次就能返回我们需要的全部内容。
 */
export class AgentLoop {
  private plan = new PlanTracker();
  private history: ChatMessage[] = [];
  private totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  constructor(private opts: AgentOptions) {
    this.history = emptyHistory();
  }

  async run(userTask: string): Promise<AgentRunResult> {
    this.history.push(userTurn(userTask));

    const { config: cfg, client, registry, onAssistantTurn, onToolResult } = this.opts;
    const toolRunner: ToolRunner = new ToolRunner(registry, {
      workdir: cfg.workdir,
      timeoutMs: cfg.toolTimeoutMs,
      maxOutputChars: cfg.maxOutputChars,
    });

    for (let step = 1; step <= cfg.maxSteps; step++) {
      const system = this.buildSystemWithPlan();

      let resp: ChatResponse;
      try {
        resp = await client.chat({
          system,
          messages: this.history,
          tools: registry.toOpenAITools(),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          final: `LLM call failed: ${message}`,
          steps: step - 1,
          history: this.history,
          stoppedReason: 'error',
          totalUsage: this.totalUsage,
        };
      }

      this.totalUsage.promptTokens += resp.usage.promptTokens;
      this.totalUsage.completionTokens += resp.usage.completionTokens;
      this.totalUsage.totalTokens += resp.usage.totalTokens;

      // Pull structured tool calls out (defensive: ids / names may be missing).
      // 抽出结构化的 tool calls（防御性：id / name 可能缺失）。
      const calls: ToolCall[] = resp.toolCalls
        .filter((t) => t.id && t.name)
        .map((t) => ({ id: t.id, name: t.name, arguments: t.arguments }));

      // Update plan tracker with the latest assistant text.
      // 用最新一条 assistant 文本来更新计划追踪器。
      this.plan.updateFromAssistant(resp.content);
      this.plan.markStepDone();

      // Record the assistant turn. If there are tool calls, the OpenAI wire
      // format requires the assistant message to carry them so subsequent
      // tool messages can reference their ids.
      // 记录这一轮 assistant。如果有 tool calls，OpenAI 线协议要求
      // assistant 消息把它们带上，这样后续的 tool 消息才能引用这些 id。
      this.history.push(assistantTurn(resp.content, calls.length > 0 ? calls : undefined));

      onAssistantTurn?.(resp);

      // No tool calls -> the model is done. Return its final message.
      // 没有 tool calls → 模型认为任务结束。直接返回它的最终消息。
      if (calls.length === 0) {
        return {
          final: resp.content || '(assistant returned no content and no tool calls)',
          steps: step,
          history: this.history,
          stoppedReason: 'finished',
          totalUsage: this.totalUsage,
        };
      }

      // Execute each tool call sequentially, append results to history.
      // 串行执行每个 tool call，把结果追加到 history。
      const runs = await toolRunner.runAll(calls);
      for (const { call, result, durationMs } of runs) {
        const body = result.ok ? result.output : `${result.error ?? 'error'}: ${result.output}`;
        this.history.push(toolResult(call.id, body, result.ok));
        onToolResult?.(call, body, result.ok, durationMs);
      }
    }

    return {
      final: `Reached max steps (${cfg.maxSteps}) without a final answer.`,
      steps: cfg.maxSteps,
      history: this.history,
      stoppedReason: 'max_steps',
      totalUsage: this.totalUsage,
    };
  }

  private buildSystemWithPlan(): string {
    const base = buildSystemPrompt(this.opts.config.workdir);
    const planSection = `\n\nCURRENT PLAN\n${this.plan.renderForPrompt()}\n\nWhen the plan changes, wrap the new plan in <plan>...</plan> so the tracker can pick it up.`;
    return base + planSection;
  }
}
