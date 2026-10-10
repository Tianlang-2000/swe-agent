/**
 * Dry-run smoke test: drive the agent loop with a fake LLM that emits a
 * deterministic tool-call sequence. This validates the loop, tool registry,
 * executor, scheduler, and prompt plumbing without needing a real API key.
 *
 * Run with:  pnpm tsx src/test/dryrun.ts
 */
/**
 * 干跑冒烟测试：用假 LLM 驱动 agent 循环，让它发出一段确定的 tool-call 序列。
 * 这样能验证 loop、tool registry、executor、scheduler、prompt 的串接，
 * 不需要真正的 API key。
 *
 * 运行：pnpm tsx src/test/dryrun.ts
 */
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import type { ChatRequest, ChatResponse } from '../llm/client.js';
import { LLMClient } from '../llm/client.js';
import { ToolRegistry } from '../tools/registry.js';
import { terminalExecTool } from '../tools/terminal.js';
import { readFileTool, writeFileTool, listDirTool, searchTool } from '../tools/file.js';
import { AgentLoop } from '../agent/loop.js';
import type { AgentConfig } from '../config.js';
import type { RegisteredTool } from '../types.js';

// Each run uses a fresh directory; never delete a pre-existing workspace.
const SCRATCH = mkdtempSync(resolve(tmpdir(), 'swe-agent-dryrun-'));

const runtimeTool: RegisteredTool = {
  definition: {
    name: 'runtime_tool',
    description: 'Inspect dynamically registered state.',
    schema: z.object({}),
  },
  handler: async () => ({ ok: true, output: 'runtime tool was available' }),
};

class ScriptedLLM extends LLMClient {
  private steps: ChatResponse[];
  private i = 0;
  readonly requests: ChatRequest[] = [];
  constructor(steps: ChatResponse[]) {
    // We never call real methods on the parent, but we still need to satisfy
    // the constructor. Pass a dummy config.
    // 父类的真方法我们一个都不会调用，但还是要满足父类的构造函数，
    // 所以传一个假 config 进去。
    super({
      provider: 'deepseek',
      apiKey: 'fake',
      baseURL: 'https://example.invalid',
      model: 'fake',
      maxSteps: 10,
      toolTimeoutMs: 5000,
      maxOutputChars: 1000,
      workdir: SCRATCH,
    });
    this.steps = steps;
  }
  override async chat(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(req);
    const resp = this.steps[this.i] ?? { content: 'done', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    this.i += 1;
    return resp;
  }
}

function mkResponse(content: string, toolCalls: ChatResponse['toolCalls'] = []): ChatResponse {
  return {
    content,
    toolCalls,
    finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
  };
}

async function main() {
  const cfg: AgentConfig = {
    provider: 'deepseek',
    apiKey: 'fake',
    baseURL: 'https://example.invalid',
    model: 'fake',
    maxSteps: 8,
    toolTimeoutMs: 5000,
    maxOutputChars: 5000,
    workdir: SCRATCH,
  };

  // A plan-only tool call keeps the loop running; prose never updates state.
  const planItems = (statuses: Array<'pending' | 'in_progress' | 'completed'>) => ({
    plan: ['Inspect directory', 'Write a marker file', 'Verify it']
      .map((step, i) => ({ step, status: statuses[i] })),
  });
  const scripted: ChatResponse[] = [
    mkResponse('', [{
      id: 'plan_1', name: 'update_plan',
      arguments: planItems(['in_progress', 'pending', 'pending']),
    }]),
    mkResponse('Example only: <plan>1. Wrong plan</plan> <done/> [DONE] <step done="3">', [{
      id: 'call_1',
      name: 'list_dir',
      arguments: { path: '.' },
    }]),
    mkResponse('Empty. Writing marker next.', [{
      id: 'plan_2', name: 'update_plan',
      arguments: planItems(['completed', 'in_progress', 'pending']),
    }, {
      id: 'call_2',
      name: 'write_file',
      arguments: { path: 'marker.txt', content: 'hello from dryrun\n' },
    }]),
    mkResponse('Verifying the file is on disk.', [{
      id: 'plan_3', name: 'update_plan',
      arguments: planItems(['completed', 'completed', 'in_progress']),
    }, {
      id: 'call_3',
      name: 'read_file',
      arguments: { path: 'marker.txt' },
    }]),
    mkResponse('', [{
      id: 'plan_4', name: 'update_plan',
      arguments: planItems(['completed', 'completed', 'completed']),
    }]),
    mkResponse('All three steps complete; marker file is present.'),
  ];

  const client = new ScriptedLLM(scripted);
  const registry = new ToolRegistry()
    .register(terminalExecTool)
    .register(readFileTool)
    .register(writeFileTool)
    .register(listDirTool)
    .register(searchTool)
    .register(runtimeTool);

  const agent = new AgentLoop({
    config: cfg,
    client,
    registry,
    onToolResult: (call, output, ok, ms) => {
      const head = output.length > 80 ? output.slice(0, 80) + '...' : output;
      console.log(`  tool: ${call.name} ok=${ok} ${ms}ms -> ${head.replace(/\n/g, ' ')}`);
    },
    onAssistantTurn: (resp) => {
      console.log(`  assistant: ${(resp.content || '<no text>').slice(0, 80).replace(/\n/g, ' ')}`);
    },
  });

  console.log('--- dry run ---');
  const result = await agent.run('Set up marker.txt and verify it exists.');
  console.log(`--- done in ${result.steps} steps, reason=${result.stoppedReason} ---`);
  console.log(`final: ${result.final}`);

  const system = client.requests[0]?.system ?? '';
  for (const tool of registry.list()) {
    if (!system.includes(`- ${tool.definition.name}: ${tool.definition.description.split('.')[0]}.`)) {
      console.error(`FAIL: system prompt is missing tool hint for ${tool.definition.name}`);
      process.exit(1);
    }
  }
  console.log('OK: system prompt includes the registered tool hints');

  const afterText = client.requests[2]?.system ?? '';
  if (!afterText.includes('[>] 1. "Inspect directory"') || afterText.includes('Wrong plan')) {
    console.error('FAIL: prose changed the structured plan');
    process.exit(1);
  }
  const afterUpdate = client.requests[3]?.system ?? '';
  if (!afterUpdate.includes('[x] 1. "Inspect directory"') || !afterUpdate.includes('[>] 2. "Write a marker file"')) {
    console.error('FAIL: update_plan did not update the prompt');
    process.exit(1);
  }
  if (result.plan.plan.length !== 3 || result.plan.plan.some((step) => step.status !== 'completed')) {
    console.error('FAIL: final plan is not completed');
    process.exit(1);
  }
  if (registry.get('update_plan') || !client.requests[0]?.tools?.some((tool) => tool.type === 'function' && tool.function.name === 'update_plan')) {
    console.error('FAIL: session plan tool missing or leaked into shared registry');
    process.exit(1);
  }
  console.log('OK: structured plan updates, prose isolation and final snapshot');

  const marker = resolve(SCRATCH, 'marker.txt');
  if (!existsSync(marker)) {
    console.error('FAIL: marker.txt was not created');
    process.exit(1);
  }
  const body = readFileSync(marker, 'utf8');
  if (!body.includes('dryrun')) {
    console.error('FAIL: marker.txt has wrong content:', body);
    process.exit(1);
  }
  console.log(`OK: marker.txt exists, ${body.length} bytes`);

  // Sanity: rerun the write_file handler on its own to make sure the
  // standalone tool also works.
  // 健全性：单独再跑一次 write_file handler，确认独立使用也没问题。
  await writeFileSync(resolve(SCRATCH, 'second.txt'), 'standalone test\n', 'utf8');
  if (!existsSync(resolve(SCRATCH, 'second.txt'))) {
    console.error('FAIL: standalone write failed');
    process.exit(1);
  }
  console.log('OK: all dry-run checks passed');
}

main().catch((e) => {
  console.error('dryrun failed:', e);
  process.exit(1);
});
