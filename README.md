# swe-agent

A minimal software-engineering agent in TypeScript. ~500 LOC, zero magic, designed to be read end-to-end.

## Quick Start

```powershell
# 1. Configure your provider + API key
copy .env.example .env       # then edit .env: set LLM_PROVIDER + the matching API key

# 2. Install + verify it compiles
pnpm install && pnpm typecheck

# 3. Smoke test — no API key needed
pnpm tsx src/test/dryrun.ts

# 4. Run the real agent against your chosen provider
pnpm demo
```

Set `LLM_PROVIDER=deepseek` (with `DEEPSEEK_API_KEY`) or `LLM_PROVIDER=minimax` (with `MINIMAX_API_KEY`) in `.env`. See [Setup](#setup) for the full walkthrough, and [Tools](#tools) / [Operating limits](#operating-limits-env-tunable) for tuning.

## What it does

Given a task, the agent runs an **observe → think → act** loop:

1. **Plan** — the assistant emits a `<plan>...</plan>` block; the `PlanTracker` stores it and renders it back into the system prompt each turn so the model keeps a stable "where am I?" anchor.
2. **Act** — the assistant calls one or more tools. Each call is validated by Zod, dispatched to a handler, and the result is appended to chat history.
3. **Observe** — the next LLM call sees the tool result, decides the next move, and either calls another tool or returns a final message.
4. **Stop** — when the assistant emits no tool calls, the loop ends.

## Components

```
src/
├── config.ts            # env loader (LLM_PROVIDER, keys, base URLs, limits)
├── types.ts             # ChatMessage, ToolCall, ToolDefinition, ToolResult, ...
├── agent/
│   ├── loop.ts          # the main observe→think→act loop
│   ├── scheduler.ts     # PlanTracker: <plan> block parser + plan renderer
│   └── prompt.ts        # system prompt + history helpers
├── llm/
│   ├── client.ts        # OpenAI-compatible client (works with DeepSeek + MiniMax)
│   └── parser.ts        # defensive tool-call filtering / summary
├── tools/
│   ├── schema.ts        # Zod → OpenAI tool schema conversion
│   ├── registry.ts      # tool registry with validation + error wrapping
│   ├── terminal.ts      # terminal_exec (spawn, capture, kill on timeout)
│   └── file.ts          # read_file, write_file, list_dir, search (ripgrep)
├── executor/
│   └── runner.ts        # sequential tool execution with timing
├── index.ts             # public API + runTask() helper
├── demo.ts              # demo runner
└── test/
    └── dryrun.ts        # scripted end-to-end smoke test (no API key needed)
```

## Supported LLM providers

Both providers expose OpenAI-compatible Chat Completions APIs, so we use a single `openai` SDK client and switch by `baseURL`.

| Provider | Default base URL | Default model | Env var |
|---|---|---|---|
| `deepseek` | `https://api.deepseek.com/v1` | `deepseek-chat` | `DEEPSEEK_API_KEY` |
| `minimax`  | `https://api.minimaxi.com/v1` | `MiniMax-Text-01`  | `MINIMAX_API_KEY`  |

Pick one with `LLM_PROVIDER=deepseek` or `LLM_PROVIDER=minimax`.

## Setup

```powershell
# from the swe-agent/ directory
copy .env.example .env
# edit .env and fill in your key
pnpm install
pnpm typecheck         # verify everything compiles
pnpm tsx src/test/dryrun.ts   # end-to-end smoke test (no API key needed)
pnpm demo              # run the real demo against your chosen provider
```

## Tools

| Name | Args | Purpose |
|---|---|---|
| `terminal_exec` | `{ command, max_wait_ms? }` | Spawn a shell command, capture stdout+stderr, kill on timeout. |
| `read_file` | `{ path, start_line?, end_line? }` | Read a text file (or a line range). |
| `write_file` | `{ path, content, create_dirs? }` | Overwrite a file; optionally create parent dirs. |
| `list_dir` | `{ path?, max_depth? }` | List files/dirs (one entry per line, `[D]` / `[F]` prefix). |
| `search` | `{ pattern, path?, glob?, case_insensitive?, max_results?, context? }` | ripgrep regex search. |

All file tools are **path-safe**: a path that escapes the working directory via `..` or an absolute path outside the workdir throws.

## Operating limits (env-tunable)

| Variable | Default | Meaning |
|---|---|---|
| `MAX_STEPS` | 40 | Hard cap on loop iterations. |
| `TOOL_TIMEOUT_MS` | 60000 | Per-tool timeout. |
| `MAX_OUTPUT_CHARS` | 50000 | Truncation cap on tool outputs. |
| `WORKDIR` | `.` | Working directory for all file/terminal ops. |

## Public API

```ts
import { loadConfig, LLMClient, ToolRegistry, AgentLoop, buildDefaultRegistry, runTask } from 'swe-agent';

// turnkey:
const result = await runTask('Refactor foo.ts to use the new helper');

// or build your own:
const cfg = loadConfig();
const client = new LLMClient(cfg);
const registry = buildDefaultRegistry();         // wires the 5 core tools
const agent = new AgentLoop({
  config: cfg,
  client,
  registry,
  onAssistantTurn: (r) => console.log('A:', r.content),
  onToolResult: (call, out, ok, ms) => console.log(`T: ${call.name} ok=${ok} ${ms}ms`),
});
const result = await agent.run('...');
```

`AgentRunResult` has: `final`, `steps`, `history`, `stoppedReason` (`finished` | `max_steps` | `error`), `totalUsage`.

## Design notes

- **Loop is single-threaded by design.** Parallelising tool calls inside a turn adds nondeterminism and rarely helps in SWE tasks where most ops mutate state.
- **Plan lives in `<plan>` blocks in assistant text.** Cheap, no extra schema, and the model can rewrite it whenever its understanding changes.
- **Tool results are truncated, never the process.** A runaway `cat` shouldn't OOM the agent — the binary keeps running but only the first N chars enter the prompt.
- **Zod is the trust boundary.** Every tool call is re-validated at dispatch. The LLM cannot inject paths outside `WORKDIR` or skip required fields.
- **Provider is one env var.** Switching DeepSeek ↔ MiniMax is `LLM_PROVIDER=...` and reload; the SDK and tool protocol are the same.

## What's deliberately not here

- Streaming responses. Add `stream: true` to the SDK call when you need it.
- Sub-agents / DAG-style task graphs. Plan-and-execute is enough for one-task-at-a-time SWE work.
- Persistence. The chat history lives in memory; wire a `JsonHistoryStore` if you need resume.
- A CLI. The demo script is the entry point. Wrap `runTask()` in your own CLI when you need one.