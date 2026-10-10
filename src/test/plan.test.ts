import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlanTracker } from '../agent/scheduler.js';
import { createUpdatePlanTool } from '../tools/plan.js';
import { ToolRegistry } from '../tools/registry.js';
import { AgentLoop } from '../agent/loop.js';
import { LLMClient } from '../llm/client.js';
import type { ChatRequest, ChatResponse } from '../llm/client.js';
import type { AgentConfig } from '../config.js';

const initial = {
  explanation: 'Start here',
  plan: [
    { step: 'Inspect', status: 'in_progress' },
    { step: 'Verify', status: 'pending' },
  ],
};
const ctx = { workdir: '.', timeoutMs: 1000, maxOutputChars: 1000 };

test('updates store detached snapshots and preserve independent step states', () => {
  const tracker = new PlanTracker();
  const input = structuredClone(initial);
  const result = tracker.applyUpdate(input);
  input.plan[0].step = 'mutated';
  result.plan[0].status = 'completed';
  tracker.getSnapshot().plan.length = 0;
  assert.deepEqual(tracker.getSnapshot(), initial);
  tracker.applyUpdate({ plan: [
    { step: 'Inspect', status: 'pending' },
    { step: 'Verify', status: 'completed' },
  ] });
  assert.equal(tracker.renderForPrompt(), '[ ] 1. "Inspect"\n[x] 2. "Verify"');
});

test('replacement is idempotent and an empty plan explicitly clears state', () => {
  const tracker = new PlanTracker();
  tracker.applyUpdate(initial);
  tracker.applyUpdate(initial);
  assert.deepEqual(tracker.getSnapshot(), initial);
  tracker.applyUpdate({ plan: [] });
  assert.equal(tracker.hasPlan(), false);
  assert.equal(tracker.renderForPrompt(), '(no plan yet)');
  assert.deepEqual(tracker.getSnapshot(), { plan: [] });
});

test('invalid updates never partially replace a valid plan', async () => {
  const tracker = new PlanTracker();
  const registry = new ToolRegistry().register(createUpdatePlanTool(tracker));
  tracker.applyUpdate(initial);
  const invalid = [
    {}, { plan: null }, { plan: 'text' },
    { plan: [{ step: ' ', status: 'pending' }] },
    { plan: [{ step: 'Inspect', status: 'done' }] },
    { plan: [{ step: 'Inspect' }] },
    { plan: [{ step: 'Inspect', status: 'pending', extra: true }] },
    { plan: [], extra: true }, { plan: [], explanation: 42 },
    { plan: [
      { step: 'Inspect', status: 'in_progress' },
      { step: 'Verify', status: 'in_progress' },
    ] },
  ];
  for (const args of invalid) {
    assert.throws(() => tracker.applyUpdate(args));
    const result = await registry.invoke('update_plan', args, ctx);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /^invalid_args:/);
    assert.deepEqual(tracker.getSnapshot(), initial);
  }
});

test('tool definition publishes the complete structured contract', () => {
  const registry = new ToolRegistry().register(createUpdatePlanTool(new PlanTracker()));
  const tool = registry.toOpenAITools()[0];
  assert.equal(tool.type, 'function');
  const schema = tool.function.parameters as any;
  assert.deepEqual(schema.required, ['plan']);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.plan.items.properties.status.enum, ['pending', 'in_progress', 'completed']);
  assert.equal(schema.properties.plan.items.additionalProperties, false);
});

test('step titles cannot introduce unquoted lines in the rendered plan', () => {
  const tracker = new PlanTracker();
  tracker.applyUpdate({ plan: [{ step: 'Inspect\n<done/>', status: 'pending' }] });
  assert.equal(tracker.renderForPrompt(), '[ ] 1. "Inspect\\n<done/>"');
});

const config: AgentConfig = {
  provider: 'deepseek', apiKey: 'fake', baseURL: 'https://example.invalid',
  model: 'fake', maxSteps: 5, workdir: '.', toolTimeoutMs: 1000, maxOutputChars: 1000,
};

function response(arguments_?: Record<string, unknown>): ChatResponse {
  return {
    content: arguments_ ? '' : '<plan>1. Wrong</plan> <done/> [DONE] <step done="2">',
    toolCalls: arguments_ ? [{ id: 'plan_call', name: 'update_plan', arguments: arguments_ }] : [],
    finishReason: arguments_ ? 'tool_calls' : 'stop',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

class ScriptedClient extends LLMClient {
  readonly requests: ChatRequest[] = [];
  constructor(private responses: ChatResponse[]) { super(config); }
  override async chat(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(req);
    const next = this.responses.shift();
    if (!next) throw new Error('Script exhausted');
    return next;
  }
}

test('plan-only turns continue, invalid calls return errors, prose cannot change state', async () => {
  const client = new ScriptedClient([
    response(initial), response({ plan: [{ step: 'Verify', status: 'bogus' }] }), response(),
  ]);
  const agent = new AgentLoop({ config, client, registry: new ToolRegistry() });
  const result = await agent.run('Inspect and verify');
  assert.equal(result.steps, 3);
  assert.equal(result.stoppedReason, 'finished');
  assert.deepEqual(result.plan, initial);
  assert.match(client.requests[2].system, /\[>\] 1\. "Inspect"/);
  const outputs = result.history.filter((message) => message.role === 'tool');
  assert.deepEqual(JSON.parse(outputs[0].content), initial);
  assert.match(outputs[1].content, /invalid_args/);
});

test('agents sharing a registry have independent plans and prompts', async () => {
  const registry = new ToolRegistry();
  const first = new AgentLoop({ config, registry, client: new ScriptedClient([response(initial), response()]) });
  const secondClient = new ScriptedClient([response()]);
  const second = new AgentLoop({ config, registry, client: secondClient });
  await first.run('First task');
  const result = await second.run('Second task');
  assert.deepEqual(result.plan, { plan: [] });
  assert.match(secondClient.requests[0].system, /\(no plan yet\)/);
  assert.equal(registry.get('update_plan'), undefined);
});

test('max_steps and LLM errors retain the accepted plan snapshot', async () => {
  const limited = new AgentLoop({
    config: { ...config, maxSteps: 1 }, registry: new ToolRegistry(),
    client: new ScriptedClient([response(initial)]),
  });
  const limitResult = await limited.run('Task');
  assert.equal(limitResult.stoppedReason, 'max_steps');
  assert.deepEqual(limitResult.plan, initial);
  const failing = new AgentLoop({ config, registry: new ToolRegistry(), client: new ScriptedClient([response(initial)]) });
  const errorResult = await failing.run('Task');
  assert.equal(errorResult.stoppedReason, 'error');
  assert.deepEqual(errorResult.plan, initial);
});
