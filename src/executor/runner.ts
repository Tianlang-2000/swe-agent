import type { ToolRegistry } from '../tools/registry.js';
import type { ToolCall, ToolContext, ToolResult } from '../types.js';

/**
 * Run a single tool call through the registry. The registry handles schema
 * validation and converts thrown errors into structured ToolResults, so
 * this layer is intentionally thin.
 */
export class ToolRunner {
  constructor(private registry: ToolRegistry, private ctx: ToolContext) {}

  async run(call: ToolCall): Promise<{ result: ToolResult; durationMs: number }> {
    const t0 = Date.now();
    const result = await this.registry.invoke(call.name, call.arguments, this.ctx);
    return { result, durationMs: Date.now() - t0 };
  }

  async runAll(calls: ToolCall[]): Promise<Array<{ call: ToolCall; result: ToolResult; durationMs: number }>> {
    // We run sequentially. Parallelising tool calls inside a single turn is
    // rarely worth the complexity in a minimal agent — most SWE calls are
    // file/terminal ops that mutate state, and serial execution keeps the
    // history deterministic.
    const out: Array<{ call: ToolCall; result: ToolResult; durationMs: number }> = [];
    for (const call of calls) {
      const { result, durationMs } = await this.run(call);
      out.push({ call, result, durationMs });
    }
    return out;
  }
}
