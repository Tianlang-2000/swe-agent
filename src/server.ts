/**
 * Minimal web UI for the agent: HTTP server + SSE stream.
 *
 *   GET  /         -> public/index.html
 *   GET  /events   -> Server-Sent Events stream of agent progress
 *   POST /run      -> start a task; body: { task, workdir? }
 *
 * Events emitted on /events:
 *   { type: 'start',        task, workdir }
 *   { type: 'assistant',    step, content }
 *   { type: 'tool_call',    step, name, args }
 *   { type: 'tool_result',  step, name, ok, output, durationMs }
 *   { type: 'error',        message }
 *   { type: 'done',         result: { stoppedReason, final, steps, usage } }
 *
 * Only one task runs at a time; new POST /run while busy returns 409.
 */
/**
 * 给 agent 用的极简 web UI：HTTP server + SSE 流。
 *
 *   GET  /         -> public/index.html
 *   GET  /events   -> 代理进度的 Server-Sent Events 流
 *   POST /run      -> 启动一个任务；body: { task, workdir? }
 *
 * /events 上发的事件：
 *   { type: 'start',        task, workdir }
 *   { type: 'assistant',    step, content }
 *   { type: 'tool_call',    step, name, args }
 *   { type: 'tool_result',  step, name, ok, output, durationMs }
 *   { type: 'error',        message }
 *   { type: 'done',         result: { stoppedReason, final, steps, usage } }
 *
 * 同一时间只能跑一个任务；忙时再次 POST /run 会返回 409。
 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { LLMClient } from './llm/client.js';
import { buildDefaultRegistry } from './index.js';
import { AgentLoop } from './agent/loop.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_DIR = resolve(__dirname, '../public');
const PORT = Number(process.env.PORT) || 3000;

if (!existsSync(PUBLIC_DIR)) {
  mkdirSync(PUBLIC_DIR, { recursive: true });
}

// ---------- Event types ----------
// ---------- 事件类型 ----------

type AgentEvent =
  | { type: 'start'; task: string; workdir: string; model: string; provider: string }
  | { type: 'assistant'; step: number; content: string; toolCallNames: string[] }
  | { type: 'tool_call'; step: number; name: string; args: unknown }
  | { type: 'tool_result'; step: number; name: string; ok: boolean; output: string; durationMs: number }
  | { type: 'error'; message: string }
  | {
      type: 'done';
      result: {
        stoppedReason: string;
        final: string;
        steps: number;
        usage: { promptTokens: number; completionTokens: number; totalTokens: number };
      };
    };

// ---------- Job state (single in-flight task) ----------
// ---------- 任务状态（同一时间只跑一个） ----------

interface Job {
  clients: Set<ServerResponse>;
  busy: boolean;
}

const job: Job = { clients: new Set(), busy: false };

function broadcast(event: AgentEvent): void {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of job.clients) {
    try {
      client.write(payload);
    } catch {
      job.clients.delete(client);
    }
  }
}

// ---------- Run the agent, broadcasting events ----------
// ---------- 跑 agent，把事件广播出去 ----------

async function runAgent(task: string, workdir: string | undefined): Promise<void> {
  let stepCounter = 0;
  try {
    const cfg = loadConfig();
    if (workdir && workdir.trim()) cfg.workdir = resolve(workdir);

    const client = new LLMClient(cfg);
    const registry = buildDefaultRegistry();
    const agent = new AgentLoop({
      config: cfg,
      client,
      registry,
      onAssistantTurn: (resp) => {
        stepCounter += 1;
        broadcast({
          type: 'assistant',
          step: stepCounter,
          content: resp.content,
          toolCallNames: resp.toolCalls.map((c) => c.name),
        });
        // Emit a tool_call event per call so the UI shows it before the result.
        // 每个 tool call 单独发一个 tool_call 事件，让 UI 在结果出来前先看到调用。
        for (const c of resp.toolCalls) {
          broadcast({
            type: 'tool_call',
            step: stepCounter,
            name: c.name,
            args: c.arguments,
          });
        }
      },
      onToolResult: (call, output, ok, durationMs) => {
        broadcast({
          type: 'tool_result',
          step: stepCounter,
          name: call.name,
          ok,
          output,
          durationMs,
        });
      },
    });

    broadcast({
      type: 'start',
      task,
      workdir: cfg.workdir,
      model: cfg.model,
      provider: cfg.provider,
    });

    const result = await agent.run(task);

    broadcast({
      type: 'done',
      result: {
        stoppedReason: result.stoppedReason,
        final: result.final,
        steps: result.steps,
        usage: result.totalUsage,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    broadcast({ type: 'error', message });
  } finally {
    job.busy = false;
  }
}

// ---------- HTTP routing ----------
// ---------- HTTP 路由 ----------

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolveBody(data));
    req.on('error', rejectBody);
  });
}

const server = createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url ?? '/';

  // Static index.html
  // 静态 index.html
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    const indexPath = join(PUBLIC_DIR, 'index.html');
    if (!existsSync(indexPath)) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`index.html not found at ${indexPath}`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(indexPath));
    return;
  }

  // SSE stream
  // SSE 流
  if (req.method === 'GET' && url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    job.clients.add(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      job.clients.delete(res);
    });
    return;
  }

  // Start a task
  // 启动一个任务
  if (req.method === 'POST' && url === '/run') {
    if (job.busy) {
      sendJson(res, 409, { error: 'Agent is already running. Wait for the current task to finish.' });
      return;
    }
    let raw: string;
    try {
      raw = await readBody(req);
    } catch {
      sendJson(res, 400, { error: 'Failed to read request body' });
      return;
    }
    let parsed: { task?: string; workdir?: string };
    try {
      parsed = JSON.parse(raw || '{}');
    } catch {
      sendJson(res, 400, { error: 'Body must be valid JSON' });
      return;
    }
    const task = (parsed.task ?? '').trim();
    if (!task) {
      sendJson(res, 400, { error: 'task is required' });
      return;
    }
    job.busy = true;
    sendJson(res, 202, { ok: true, message: 'Task started. Watch /events for progress.' });
    // Fire-and-forget; runAgent manages job.busy in finally.
    // fire-and-forget；runAgent 在 finally 里会把 job.busy 复位。
    runAgent(task, parsed.workdir).catch((err) => {
      console.error('runAgent uncaught:', err);
      job.busy = false;
    });
    return;
  }

  // Status
  // 状态
  if (req.method === 'GET' && url === '/status') {
    sendJson(res, 200, { busy: job.busy, clients: job.clients.size });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`swe-agent web UI ready: http://localhost:${PORT}`);
  console.log(`  POST /run     start a task`);
  console.log(`  GET  /events  SSE stream of progress`);
  console.log(`  GET  /status  { busy, clients }`);
});
