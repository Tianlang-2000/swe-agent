import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { ToolResult, ToolContext, RegisteredTool } from '../types.js';

const ExecArgsSchema = z.object({
  command: z.string().min(1).describe('The shell command to execute. Runs via the platform shell (cmd on Windows, sh elsewhere).'),
  max_wait_ms: z.number().int().positive().optional().describe('Override the default per-tool timeout in milliseconds.'),
});

/**
 * Run a command, capture stdout + stderr up to a byte cap, kill on timeout.
 * The output is truncated (not the process) to keep prompt sizes bounded.
 */
async function runCommand(
  command: string,
  ctx: ToolContext,
  timeoutMs: number,
): Promise<ToolResult> {
  const isWindows = process.platform === 'win32';
  const shell = isWindows ? 'cmd.exe' : '/bin/sh';
  const shellArgs = isWindows ? ['/d', '/s', '/c', command] : ['-c', command];

  return new Promise<ToolResult>((resolve) => {
    const child = spawn(shell, shellArgs, {
      cwd: ctx.workdir,
      env: process.env,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutCap = ctx.maxOutputChars;
    const stderrCap = Math.floor(ctx.maxOutputChars / 2);

    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdout.length < stdoutCap) {
        stdout += chunk.toString('utf8');
        if (stdout.length > stdoutCap) stdout = stdout.slice(0, stdoutCap);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderr.length < stderrCap) {
        stderr += chunk.toString('utf8');
        if (stderr.length > stderrCap) stderr = stderr.slice(0, stderrCap);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        output: '',
        error: `spawn_error: ${err.message}`,
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const truncatedNote =
        stdoutBytes > stdoutCap || stderrBytes > stderrCap
          ? `\n\n[truncated: stdout=${stdoutBytes}B stderr=${stderrBytes}B, cap=${stdoutCap}/${stderrCap} chars]`
          : '';

      const parts: string[] = [];
      if (stdout) parts.push(`[stdout]\n${stdout}`);
      if (stderr) parts.push(`[stderr]\n${stderr}`);
      if (killed) parts.push(`[killed after ${timeoutMs}ms timeout]`);
      const output = parts.join('\n\n') + truncatedNote;

      if (killed || signal) {
        resolve({
          ok: false,
          output,
          error: killed ? 'timeout' : `signal:${signal}`,
        });
        return;
      }

      resolve({
        ok: code === 0,
        output,
        error: code === 0 ? undefined : `exit_code:${code}`,
      });
    });
  });
}

export const terminalExecTool: RegisteredTool = {
  definition: {
    name: 'terminal_exec',
    description:
      'Execute a shell command in the working directory. Returns combined stdout+stderr, ' +
      'truncated to a safe size. Long-running or interactive commands will hit the timeout ' +
      'and be killed — prefer non-interactive flags (e.g. --yes, --non-interactive).',
    schema: ExecArgsSchema,
  },
  handler: async (args, ctx) => {
    const { command, max_wait_ms } = args as z.infer<typeof ExecArgsSchema>;
    const timeout = max_wait_ms ?? ctx.timeoutMs;
    return runCommand(command, ctx, timeout);
  },
};
