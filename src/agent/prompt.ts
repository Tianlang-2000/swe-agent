import type { ToolRegistry } from '../tools/registry.js';
import type { ChatMessage } from '../types.js';

/**
 * Build the system prompt. The agent has a small, sharp identity — it does
 * software-engineering tasks by calling tools. We keep this in code (not in
 * a config file) so the contract is explicit and reviewable.
 */
export function buildSystemPrompt(workdir: string): string {
  return `You are a minimal software-engineering agent. You solve tasks by calling tools.

WORKING DIRECTORY: ${workdir}
- All file paths are relative to this directory unless absolute (and must stay inside it).
- All terminal commands run here too.

TOOLS
- terminal_exec: run shell commands, capture stdout+stderr, kill on timeout.
- read_file: read a slice of a text file by line range.
- write_file: overwrite a file (optionally create parent dirs).
- list_dir: list files/directories up to a depth.
- search: ripgrep regex search across files.

OPERATING LOOP
1. Read the user's task. If anything is ambiguous, ask one short question.
2. Plan: write a short TODO list of 3-7 concrete steps in your first reply.
3. Execute: for each step, call the right tool. After each tool result, decide
   whether the step is done and move on.
4. Verify: run the project's tests or a focused command to confirm the fix.
5. Finish: when the task is done, reply with a concise summary and stop calling tools.

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
  // We surface errors in the content so the LLM sees them; the role itself
  // is still 'tool' so the API contract is satisfied.
  const body = ok ? output : `[error] ${output}`;
  return { role: 'tool', content: body, tool_call_id: toolCallId };
}

export function toolRegistryPromptHint(registry: ToolRegistry): string {
  const names = registry.list().map((t) => `- ${t.definition.name}: ${t.definition.description.split('.')[0]}.`).join('\n');
  return `AVAILABLE TOOLS\n${names}`;
}
