# swe-agent

A minimal software-engineering agent in TypeScript. ~500 LOC, zero magic, designed to be read end-to-end.

> 中文版：[README.md](./README.md)

---

## 30-second quickstart

```powershell
# 0. Prerequisite: Node >= 20 (declared in package.json's engines)
node -v

# 1. Install
npm install

# 2. Configure your provider + API key
copy .env.example .env       # then edit .env and fill in at least one API key

# 3. Verify it compiles
npm run typecheck

# 4. Smoke test — no API key needed
npm run dryrun

# 5a. CLI demo: scaffold a hello.py in a scratch directory
npm run demo

# 5b. Web UI: watch the agent in your browser (recommended!)
npm run web
# open http://localhost:3000
```

If you use `pnpm` or `yarn`, swap `npm` for the equivalent — script names are identical.

---

## Three ways to run it

| Mode | Command | When to use |
|---|---|---|
| CLI demo | `npm run demo` | First end-to-end run |
| Real task | `npx tsx src/run.ts "task description"` | One-shot, supports `--workdir` |
| Web UI | `npm run web` | Interactive; see every step (essential when something fails) |

`npm run web` opens `http://localhost:3000`. You'll see, in real time:
- Each LLM reply (`assistant`)
- Tool calls (amber)
- Tool results (green ✓ / red ✗)
- Final summary (`done`)
- Any error rendered in red, prominently

---

## How it works

The classic observe → think → act loop:

1. **Plan** — the assistant emits a `<plan>...</plan>` block in its first reply. `PlanTracker` stores it and re-injects it into the system prompt every turn so the model keeps a stable "where am I?" anchor.
2. **Act** — the assistant calls one or more tools. Each call is Zod-validated, dispatched to a handler, and the result is appended to chat history.
3. **Observe** — the next LLM call sees the tool result, decides what to do next, and either calls another tool or returns a final message.
4. **Stop** — when the assistant emits no tool calls, the loop ends.

---

## Project structure

```
src/
├── config.ts            # env loader (LLM_PROVIDER, keys, base URL, limits)
├── types.ts             # ChatMessage, ToolCall, ToolDefinition, ToolResult ...
├── agent/
│   ├── loop.ts          # the main observe → think → act loop
│   ├── scheduler.ts     # PlanTracker: <plan> parser + renderer
│   └── prompt.ts        # system prompt + history helpers
├── llm/
│   ├── client.ts        # OpenAI-compatible client (works with DeepSeek + MiniMax)
│   └── parser.ts        # defensive tool-call filtering / summarisation
├── tools/
│   ├── schema.ts        # Zod → OpenAI tool schema conversion
│   ├── registry.ts      # tool registry with validation + error wrapping
│   ├── terminal.ts      # terminal_exec (spawn, capture, kill on timeout)
│   └── file.ts          # read_file, write_file, list_dir, search (ripgrep)
├── executor/
│   └── runner.ts        # sequential tool execution with timing
├── server.ts            # Web UI HTTP + SSE server
├── index.ts             # public API + runTask() helper
├── demo.ts              # demo runner
├── test/
│   └── dryrun.ts        # scripted end-to-end smoke test (no API key needed)
└── public/
    └── index.html       # Web UI (Vue 3 + Tailwind, single file)
```

---

## Supported LLM providers

Both providers expose OpenAI-compatible Chat Completions APIs, so a single `openai` SDK client is reused and the provider is switched via `baseURL`.

| Provider | Default base URL | Default model | Env var |
|---|---|---|---|
| `deepseek` | `https://api.deepseek.com/v1` | `deepseek-chat` | `DEEPSEEK_API_KEY` |
| `minimax`  | `https://api.minimaxi.com/v1` | `MiniMax-Text-01`  | `MINIMAX_API_KEY`  |

Set `LLM_PROVIDER=deepseek` or `LLM_PROVIDER=minimax` in `.env` to switch.

> **MiniMax Coding Plan users**: if your key starts with `sk-cp-`, you must override `MINIMAX_BASE_URL` to the endpoint issued by the plan console (not `api.minimaxi.com`), and `MINIMAX_MODEL` to whatever the plan whitelists (e.g. `MiniMax-M3`).

---

## Configuration (env-tunable)

| Variable | Default | Meaning |
|---|---|---|
| `LLM_PROVIDER` | `deepseek` | Which provider to use |
| `*_API_KEY` | (required) | Matching provider key |
| `*_BASE_URL` | see table | Custom endpoint (Coding Plan users must override) |
| `*_MODEL` | see table | Model name |
| `MAX_STEPS` | `40` | Hard cap on loop iterations |
| `TOOL_TIMEOUT_MS` | `60000` | Per-tool timeout |
| `MAX_OUTPUT_CHARS` | `50000` | Truncation cap on tool outputs |
| `WORKDIR` | `.` | Working directory for all file/terminal ops |

---

## Tools

| Name | Args | Purpose |
|---|---|---|
| `terminal_exec` | `{ command, max_wait_ms? }` | Run a shell command, capture stdout+stderr, kill on timeout |
| `read_file` | `{ path, start_line?, end_line? }` | Read a text file (or a line range) |
| `write_file` | `{ path, content, create_dirs? }` | Overwrite a file; optionally create parent dirs |
| `list_dir` | `{ path?, max_depth? }` | List files/dirs (one entry per line, `[D]` / `[F]` prefix) |
| `search` | `{ pattern, path?, glob?, case_insensitive?, max_results?, context? }` | ripgrep regex search |

All file tools are **path-safe**: any path that escapes the working directory via `..` or an absolute path outside the workdir throws.

---

## Public API

```ts
import {
  loadConfig, LLMClient, ToolRegistry,
  AgentLoop, buildDefaultRegistry, runTask,
} from 'swe-agent';

// Turnkey:
const result = await runTask('Refactor foo.ts to use the new helper');

// Or assemble yourself:
const cfg = loadConfig();
const client = new LLMClient(cfg);
const registry = buildDefaultRegistry();   // wires the 5 core tools
const agent = new AgentLoop({
  config: cfg,
  client,
  registry,
  onAssistantTurn: (r) => console.log('A:', r.content),
  onToolResult: (call, out, ok, ms) =>
    console.log(`T: ${call.name} ok=${ok} ${ms}ms`),
});
const result = await agent.run('...');
```

`AgentRunResult` has: `final`, `steps`, `history`, `stoppedReason` (`finished` | `max_steps` | `error`), `totalUsage`.

---

## Web UI SSE events

The `/events` endpoint pushes these event types (the frontend renders from them):

```ts
{ type: 'start',        task, workdir, model, provider }
{ type: 'assistant',    step, content, toolCallNames }
{ type: 'tool_call',    step, name, args }
{ type: 'tool_result',  step, name, ok, output, durationMs }
{ type: 'error',        message }
{ type: 'done',         result: { stoppedReason, final, steps, usage } }
```

To add a new event type: add a branch to `AgentEvent` in `server.ts` + call `broadcast(...)`; add a case in the frontend's `handleEvent`.

---

## Troubleshooting

### `401 invalid api key` / `401 (2049)`

- 99% of the time, `LLM_PROVIDER` in `.env` doesn't match the key you filled in (e.g. you picked `minimax` but only set `DEEPSEEK_API_KEY`).
- Or the current PowerShell session has stale env vars, which take precedence over `.env` (dotenv doesn't override). Clear them:
  ```powershell
  Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:MINIMAX_API_KEY -ErrorAction SilentlyContinue
  ```
- For MiniMax Coding Plan keys (`sk-cp-...`), override `MINIMAX_BASE_URL` and `MINIMAX_MODEL` to whatever the plan console tells you.

### VS Code shows dozens of `Cannot find name 'process'`, but `npx tsc` is clean

The TS 7 Native Preview extension's language server doesn't see `@types/node`.
Already configured in `.vscode/settings.json`:
- `typescript.tsdk` forces the workspace `node_modules/typescript`
- `js/ts.experimental.useTsgo: false` disables TS 7 native

If it persists: Extensions panel → search `TypeScript` → disable the one with "7" / "native" / "tsgo" in the name.

### `npm run web` opens to a blank page / spinner

- Open DevTools (F12) → Console
- Most often the CDN is blocked. Check that `https://unpkg.com/vue@3/dist/vue.global.prod.js` and `https://cdn.tailwindcss.com` are reachable.

### All `tool_result` events are red (failed)

Open the UI, look at the actual `error` field (`exit_code:1` / `timeout` / `spawn_error: ...`). Don't just read the `final` line.  
`npm run demo` killing a long-running process like a Vite dev server falls into this — bump `MAX_STEPS` and `TOOL_TIMEOUT_MS`, or switch the task to a one-shot command like `npm create vite@latest`.

---

## Design notes

- **The loop is single-threaded by design.** Parallelising tool calls inside a turn adds nondeterminism and rarely helps in SWE tasks where most ops mutate state.
- **The plan lives in `<plan>` blocks in assistant text.** Cheap, no extra schema, and the model can rewrite it whenever its understanding changes.
- **We truncate tool outputs, never the process.** A runaway `cat` shouldn't OOM the agent — the binary keeps running but only the first N chars enter the prompt.
- **Zod is the trust boundary.** Every tool call is re-validated at dispatch. The LLM cannot inject paths outside `WORKDIR` or skip required fields.
- **Provider is one env var.** Switching DeepSeek ↔ MiniMax is `LLM_PROVIDER=...` and reload; the SDK and tool protocol are the same.

---

## What's deliberately not here (reserved)

- **Token-level streaming.** Backend uses non-streaming chat completions, so the UI gets event-level streaming. For token-level, add `stream: true` + delta events.
- **Sub-agents / DAG-style task graphs.** Plan-and-execute is enough for one-task-at-a-time SWE work.
- **Persistence.** Chat history lives in memory; wire a `JsonHistoryStore` if you need resume.
- **History UI.** The left sidebar in the Web UI is a mock — the backend doesn't persist history.
- **Cancel running tasks.** No `/stop` endpoint. Once a run starts, you have to wait for it to finish.

---

## License

ISC (per `package.json` default)
