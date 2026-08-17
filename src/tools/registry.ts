import type { RegisteredTool, ToolContext } from '../types.js';
import { toOpenAITool } from './schema.js';
import type { OpenAITool } from '../types.js';

/**
 * Central registry for tools. Order of registration = order presented to the LLM.
 */
export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): this {
    if (this.tools.has(tool.definition.name)) {
      throw new Error(`Tool ${tool.definition.name} is registered twice.`);
    }
    this.tools.set(tool.definition.name, tool);
    return this;
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  list(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  /** Convert all tools into the OpenAI wire format. */
  toOpenAITools(): OpenAITool[] {
    return this.list().map((t) => toOpenAITool(t.definition));
  }

  /**
   * Invoke a tool by name with the given (parsed) arguments.
   * Errors are caught and turned into a structured ToolResult.
   */
  async invoke(name: string, args: Record<string, unknown>, ctx: ToolContext) {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        ok: false,
        output: '',
        error: `unknown_tool:${name}`,
      };
    }

    // Validate args at the boundary. This is the trust boundary with the LLM.
    const parsed = tool.definition.schema.safeParse(args);
    if (!parsed.success) {
      return {
        ok: false,
        output: '',
        error: `invalid_args: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; ')}`,
      };
    }

    try {
      return await tool.handler(parsed.data as Record<string, unknown>, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        output: '',
        error: `execution_error: ${message}`,
      };
    }
  }
}
