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
  /** Called for every assistant turn; useful for live UI / logging. */
  onAssistantTurn?: (resp: ChatResponse) => void;
  /** Called for every tool invocation, with timing and result. */
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
      const calls: ToolCall[] = resp.toolCalls
        .filter((t) => t.id && t.name)
        .map((t) => ({ id: t.id, name: t.name, arguments: t.arguments }));

      // Update plan tracker with the latest assistant text.
      this.plan.updateFromAssistant(resp.content);
      this.plan.markStepDone();

      // Record the assistant turn. If there are tool calls, the OpenAI wire
      // format requires the assistant message to carry them so subsequent
      // tool messages can reference their ids.
      this.history.push(assistantTurn(resp.content, calls.length > 0 ? calls : undefined));

      onAssistantTurn?.(resp);

      // No tool calls -> the model is done. Return its final message.
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
