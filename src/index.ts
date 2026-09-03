import { loadConfig } from './config.js';
import { LLMClient } from './llm/client.js';
import { ToolRegistry } from './tools/registry.js';
import { terminalExecTool } from './tools/terminal.js';
import { readFileTool, writeFileTool, listDirTool, searchTool } from './tools/file.js';
import { AgentLoop } from './agent/loop.js';

export { loadConfig } from './config.js';
export { LLMClient } from './llm/client.js';
export { ToolRegistry } from './tools/registry.js';
export { AgentLoop } from './agent/loop.js';
export { PlanTracker } from './agent/scheduler.js';
export { terminalExecTool } from './tools/terminal.js';
export { readFileTool, writeFileTool, listDirTool, searchTool } from './tools/file.js';
export * from './types.js';

/** Build a default tool registry wired with the four core tools. */
/** 构造一个默认的工具注册表，预装四个核心工具。 */
export function buildDefaultRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(terminalExecTool)
    .register(readFileTool)
    .register(writeFileTool)
    .register(listDirTool)
    .register(searchTool);
}

/**
 * One-shot helper: load config, build registry + client, run a task, return
 * the result. Used by the demo script and by anyone who wants a turnkey run.
 */
/**
 * 一站式 helper：加载 config，构造 registry + client，跑一个任务，返回结果。
 * 演示脚本和想直接跑一次的人都会用到。
 */
export async function runTask(userTask: string, overrides?: { workdir?: string; maxSteps?: number }) {
  const cfg = loadConfig();
  if (overrides?.workdir) cfg.workdir = overrides.workdir;
  if (overrides?.maxSteps) cfg.maxSteps = overrides.maxSteps;

  const client = new LLMClient(cfg);
  const registry = buildDefaultRegistry();
  const agent = new AgentLoop({ config: cfg, client, registry });

  return agent.run(userTask);
}
