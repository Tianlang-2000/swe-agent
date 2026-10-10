import type { ToolRegistry } from '../tools/registry.js';
import type { ToolCall, ToolContext, ToolResult } from '../types.js';
/**
 * 通过 registry 跑一次工具调用。schema 校验和异常 → ToolResult 的转换
 * 都由 registry 负责，所以这一层故意做得很薄。
 */
export class ToolRunner {
  constructor(private registry: ToolRegistry, private ctx: ToolContext) {}

  async run(call: ToolCall): Promise<{ result: ToolResult; durationMs: number }> {
    const t0 = Date.now();
    const result = await this.registry.invoke(call.name, call.arguments, this.ctx);
    return { result, durationMs: Date.now() - t0 };
  }

  async runAll(calls: ToolCall[]): Promise<Array<{ call: ToolCall; result: ToolResult; durationMs: number }>> {
    // 我们串行执行。在最小 agent 里把单轮内的 tool calls 并行化收益不大——
    // 大多数 SWE 调用都是 file/terminal 这类有状态变更的操作，
    // 串行执行能让 history 保持确定可复现。
    const out: Array<{ call: ToolCall; result: ToolResult; durationMs: number }> = [];
    for (const call of calls) {
      const { result, durationMs } = await this.run(call);
      out.push({ call, result, durationMs });
    }
    return out;
  }
}
