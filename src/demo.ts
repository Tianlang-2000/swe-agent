/**
 * Demo runner: a tiny self-contained task the agent can solve in a few steps.
 *
 * We point the agent at a small scratch directory, ask it to create a file
 * with a specific structure, then verify the result. This exercises the full
 * loop (plan, terminal_exec, write_file, read_file) without depending on the
 * real project's codebase.
 *
 * Run with:  pnpm demo
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import { LLMClient } from './llm/client.js';
import { buildDefaultRegistry } from './index.js';
import { AgentLoop } from './agent/loop.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCRATCH = resolve(__dirname, '..', '.scratch-demo');

function setupScratch() {
  if (existsSync(SCRATCH)) {
    rmSync(SCRATCH, { recursive: true, force: true });
  }
  mkdirSync(SCRATCH, { recursive: true });
  // Seed with a starter file so the agent has something to inspect.
  const seed = `# scratch\n\nTODO: replace this with a Python hello-world script.\n`;
  const seedPath = resolve(SCRATCH, 'README.md');
  writeFileSync(seedPath, seed, 'utf8');
}

async function main() {
  setupScratch();

  const cfg = loadConfig();
  cfg.workdir = SCRATCH;
  cfg.maxSteps = 20;

  const client = new LLMClient(cfg);
  const registry = buildDefaultRegistry();
  const agent = new AgentLoop({ config: cfg, client, registry });

  const task =
    `In the working directory:\n` +
    `1. Read README.md to see the current state.\n` +
    `2. Create hello.py that prints "Hello from <your-model-name>" (use the actual model you are running on).\n` +
    `3. Run \`python hello.py\` (or \`py hello.py\` on Windows / \`python3 hello.py\` on Linux/macOS) to verify it works.\n` +
    `4. Summarise what you did in one short paragraph.`;

  console.log(`\n=== swe-agent demo ===`);
  console.log(`scratch: ${SCRATCH}`);
  console.log(`provider: ${client.describe()}`);
  console.log(`task:\n${task}\n`);

  const t0 = Date.now();
  const result = await agent.run(task);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n=== finished in ${elapsed}s, ${result.steps} steps ===`);
  console.log(`stopped: ${result.stoppedReason}`);
  console.log(`tokens:  ${result.totalUsage.totalTokens} (prompt=${result.totalUsage.promptTokens}, completion=${result.totalUsage.completionTokens})`);
  console.log(`\n--- final answer ---\n${result.final}\n`);

  // Verify the side effect: hello.py should exist.
  const helloPath = resolve(SCRATCH, 'hello.py');
  if (existsSync(helloPath)) {
    console.log(`--- hello.py on disk ---`);
    console.log(readFileSync(helloPath, 'utf8'));
  } else {
    console.log(`(hello.py was not created)`);
  }
}

main().catch((err) => {
  console.error('demo failed:', err);
  process.exit(1);
});
