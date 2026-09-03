/**
 * CLI entry point: pass a task as the first argument, optional workdir as
 * the second. The agent will operate against that workdir and stream progress
 * to stdout.
 *
 * Usage:
 *   pnpm tsx src/run.ts "fix the off-by-one in src/foo.ts"
 *   pnpm tsx src/run.ts "add a README" ./some-project
 *   pnpm tsx src/run.ts --workdir D:\path\to\project "refactor the auth module"
 *   pnpm task 42    "answer the question with code"
 *
 * Anything after the flags is treated as the task string, so you can pass
 * multi-word tasks without quoting tricks.
 */
/**
 * CLI 入口：第一个参数是任务，第二个可选参数是 workdir。
 * agent 会在该 workdir 下操作并把进度输出到 stdout。
 *
 * 用法：
 *   pnpm tsx src/run.ts "fix the off-by-one in src/foo.ts"
 *   pnpm tsx src/run.ts "add a README" ./some-project
 *   pnpm tsx src/run.ts --workdir D:\path\to\project "refactor the auth module"
 *   pnpm task 42    "answer the question with code"
 *
 * flag 之后的所有内容都被当作 task 字符串，多词任务不需要加引号。
 */
import { resolve } from 'node:path';
import { runTask } from './index.js';

interface ParsedArgs {
  workdir?: string;
  maxSteps?: number;
  task: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { task: '' };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workdir' || a === '-w') {
      out.workdir = argv[++i];
    } else if (a === '--max-steps') {
      out.maxSteps = parseInt(argv[++i], 10);
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (!a.startsWith('--')) {
      positional.push(a);
    } else {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }

  out.task = positional.join(' ').trim();
  if (!out.task) {
    printHelp();
    process.exit(1);
  }
  return out;
}

function printHelp() {
  console.log(`swe-agent — minimal SWE agent

Usage:
  pnpm tsx src/run.ts [flags] "<task>"

Flags:
  -w, --workdir <path>    working directory (defaults to .env WORKDIR)
      --max-steps <n>     override MAX_STEPS for this run
  -h, --help              show this help

Examples:
  pnpm tsx src/run.ts "list every .ts file under src/"
  pnpm tsx src/run.ts -w D:/repo "add a test for the parser"
  pnpm tsx src/run.ts --max-steps 80 "refactor the entire auth module"
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const overrides: { workdir?: string; maxSteps?: number } = {};
  if (args.workdir) overrides.workdir = resolve(args.workdir);
  if (args.maxSteps) overrides.maxSteps = args.maxSteps;

  console.log(`\n=== swe-agent ===`);
  console.log(`workdir: ${overrides.workdir ?? '(from .env)'}`);
  console.log(`task:    ${args.task}\n`);

  const t0 = Date.now();
  const result = await runTask(args.task, overrides);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n=== done in ${elapsed}s, ${result.steps} steps, reason=${result.stoppedReason} ===`);
  console.log(`tokens:  ${result.totalUsage.totalTokens} (prompt=${result.totalUsage.promptTokens}, completion=${result.totalUsage.completionTokens})`);
  console.log(`\n--- final answer ---\n${result.final}\n`);
}

main().catch((err) => {
  console.error('run failed:', err);
  process.exit(1);
});
