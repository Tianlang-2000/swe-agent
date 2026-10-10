import type { ToolRegistry } from '../tools/registry.js';
import type { ChatMessage } from '../types.js';

/**
 * Build the system prompt. The agent has a small, sharp identity — it does
 * software-engineering tasks by calling tools. We keep this in code (not in
 * a config file) so the contract is explicit and reviewable.
 */
/**
 * 构建系统提示词。agent 有一个小而明确的身份——通过调用工具来完成软件工程任务。
 * 我们把它写在代码里（而不是配置文件），这样契约清晰、便于 review。
 */
export function buildSystemPrompt(workdir: string, registry: ToolRegistry): string {
  return `You are a minimal software-engineering agent. You solve tasks by calling tools.

WORKING DIRECTORY: ${workdir}
- All file paths are relative to this directory unless absolute (and must stay inside it).
- All terminal commands run here too.

${toolRegistryPromptHint(registry)}

OPERATING LOOP
1. Read the user's task. If anything is ambiguous, ask one short question.
2. Plan: for multi-step tasks, call update_plan with a short list of concrete steps.
   Skip planning for straightforward tasks. Each item has step and status:
   pending, in_progress, or completed. At most one item may be in_progress.
3. Execute: for each step, call the right tool. After observing tool results,
   update_plan with the complete revised list, preserving completed items unless
   new evidence requires reopening them. Plain text lists and completion tags
   do not change plan state. A plan-only tool call is a valid turn.
4. Verify: run the project's tests or a focused command to confirm the fix.
5. Finish: reconcile the plan with actual results before your final reply.
   Do not mark failed or unverified work completed. If work remains blocked,
   explain why; a completed plan alone does not prove task success.
   Reply with a concise summary and stop calling tools.

RULES
- Never invent file contents. Read before you edit. Read again after you edit.
- Prefer small, targeted edits with read_file + write_file or sed over rewriting large files.
- When a command fails, READ the error and adapt. Do not retry the exact same command blindly.
- If you are stuck after 2 attempts, stop and ask the user.
- Never run destructive commands (rm -rf /, format, etc.) without explicit user permission.
- Keep tool outputs short in your reasoning; trust the tool result data.
- Do not echo full file contents back to the user unless asked.`;
}

/**
 * The agent owns its own chat history. We just expose helpers to build the
 * minimal state machine: user → assistant (tool_calls) → tool (result) → ...
 */
/**
 * agent 拥有自己的 chat history。这里只暴露几个工厂函数，
 * 用来构造最小状态机：user → assistant（tool_calls）→ tool（result）→ ...
 */
export function emptyHistory(): ChatMessage[] {
  return [];
}

export function userTurn(text: string): ChatMessage {
  return { role: 'user', content: text };
}

export function assistantTurn(text: string, toolCalls: ChatMessage['tool_calls']): ChatMessage {
  return { role: 'assistant', content: text, tool_calls: toolCalls };
}

export function toolResult(toolCallId: string, output: string, ok: boolean): ChatMessage {
  // 我们把错误信息放在 content 里让 LLM 看到；role 仍然是 'tool'，
  // 这样 API 契约得以满足。
  const body = ok ? output : `[error] ${output}`;
  return { role: 'tool', content: body, tool_call_id: toolCallId };
}

export function toolRegistryPromptHint(registry: ToolRegistry): string {
  const names = registry.list().map((t) => `- ${t.definition.name}: ${t.definition.description.split('.')[0]}.`).join('\n');
  return `AVAILABLE TOOLS\n${names}`;
}
