import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import { dirname, resolve, isAbsolute, relative, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { rgPath } from '@vscode/ripgrep';
import type { RegisteredTool, ToolResult } from '../types.js';

// ---- path safety ---------------------------------------------------------
// ---- 路径安全 -------------------------------------------------------------

/**
 * Resolve a user-supplied path against the workdir and reject anything that
 * tries to escape via `..` or absolute paths. We do this for every file tool
 * to keep the LLM inside the working directory.
 */
/**
 * 把用户提供的路径基于 workdir 解析，并拒绝任何通过 `..` 或绝对路径逃逸的尝试。
 * 每个 file 工具都过这一关，确保 LLM 始终在 workdir 之内活动。
 */
function safePath(input: string, workdir: string): string {
  const abs = isAbsolute(input) ? input : resolve(workdir, input);
  const rel = relative(workdir, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path escapes workdir: ${input}`);
  }
  return abs;
}

function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return s.slice(0, cap) + `\n\n[truncated to ${cap} chars of ${s.length}]`;
}

// ---- read_file -----------------------------------------------------------
// ---- read_file -----------------------------------------------------------

const ReadFileArgs = z.object({
  path: z.string().min(1).describe('File path relative to the working directory (or absolute within it).'),
  start_line: z.number().int().nonnegative().optional().describe('0-based start line; default 0.'),
  end_line: z.number().int().positive().optional().describe('Exclusive end line; default = file length.'),
});

export const readFileTool: RegisteredTool = {
  definition: {
    name: 'read_file',
    description:
      'Read a text file. Returns lines in [start_line, end_line). Use this before editing ' +
      'a file you have not seen. Binary files are read but the result is wrapped as a warning.',
    schema: ReadFileArgs,
  },
  handler: async (args, ctx) => {
    const { path: p, start_line, end_line } = args as z.infer<typeof ReadFileArgs>;
    const abs = safePath(p, ctx.workdir);
    const text = await readFile(abs, 'utf8');
    const lines = text.split(/\r?\n/);
    const start = start_line ?? 0;
    const end = end_line ?? lines.length;
    const slice = lines.slice(start, end);
    const header = `[file=${p} lines=${start}-${start + slice.length} of ${lines.length}]`;
    return { ok: true, output: header + '\n' + slice.join('\n') };
  },
};

// ---- write_file ----------------------------------------------------------
// ---- write_file ----------------------------------------------------------

const WriteFileArgs = z.object({
  path: z.string().min(1).describe('File path relative to the working directory.'),
  content: z.string().describe('Full file contents to write. Overwrites the existing file.'),
  create_dirs: z.boolean().optional().describe('Create parent directories if missing. Default false.'),
});

export const writeFileTool: RegisteredTool = {
  definition: {
    name: 'write_file',
    description:
      'Overwrite a file with the given content. Use create_dirs=true for new paths in ' +
      'subdirectories that do not exist yet. For small targeted edits prefer terminal sed ' +
      'or read_file + write_file.',
    schema: WriteFileArgs,
  },
  handler: async (args, ctx) => {
    const { path: p, content, create_dirs } = args as z.infer<typeof WriteFileArgs>;
    const abs = safePath(p, ctx.workdir);
    if (create_dirs) {
      await mkdir(dirname(abs), { recursive: true });
    } else {
      // surface a clear error if parent is missing
      // 父目录不存在时，给出一个明确的错误
      try {
        await stat(dirname(abs));
      } catch {
        throw new Error(`parent directory does not exist (pass create_dirs=true to create it)`);
      }
    }
    await writeFile(abs, content, 'utf8');
    return { ok: true, output: `wrote ${content.length} bytes to ${p}` };
  },
};

// ---- list_dir ------------------------------------------------------------
// ---- list_dir ------------------------------------------------------------

const ListDirArgs = z.object({
  path: z.string().optional().describe('Directory path; default = working directory.'),
  max_depth: z.number().int().positive().max(5).optional().describe('Recursion depth; default 1.'),
});

export const listDirTool: RegisteredTool = {
  definition: {
    name: 'list_dir',
    description:
      'List files and directories under `path` up to `max_depth` (default 1). Hidden files ' +
      'are included. Output format: one line per entry, prefixed with [D] or [F].',
    schema: ListDirArgs,
  },
  handler: async (args, ctx) => {
    const { path: p, max_depth } = args as z.infer<typeof ListDirArgs>;
    const root = p ? safePath(p, ctx.workdir) : ctx.workdir;
    const depth = max_depth ?? 1;
    const out: string[] = [];
    async function walk(dir: string, current: number) {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = `${dir}${sep}${entry.name}`;
        const rel = relative(ctx.workdir, full);
        const tag = entry.isDirectory() ? '[D]' : '[F]';
        out.push(`${tag} ${rel}`);
        if (entry.isDirectory() && current < depth) {
          await walk(full, current + 1);
        }
      }
    }
    await walk(root, 1);
    return { ok: true, output: truncate(out.join('\n') || '(empty)', ctx.maxOutputChars) };
  },
};

// ---- search (ripgrep) ----------------------------------------------------
// ---- search (ripgrep) ----------------------------------------------------

const SearchArgs = z.object({
  pattern: z.string().min(1).describe('Regex pattern to search for. Anchored per line.'),
  path: z.string().optional().describe('File or directory to search; default = working directory.'),
  glob: z.string().optional().describe('Restrict to files matching this glob, e.g. "*.ts".'),
  case_insensitive: z.boolean().optional().describe('Case-insensitive match; default false.'),
  max_results: z.number().int().positive().max(500).optional().describe('Cap on result lines; default 100.'),
  context: z.number().int().nonnegative().max(20).optional().describe('Lines of context around each match; default 0.'),
});

/**
 * ripgrep ships as a platform-specific binary via @vscode/ripgrep. We shell out
 * to it because linking its native API in pure JS is more work than it's worth
 * for a minimal agent. The package exports the resolved binary path as `rgPath`.
 */
/**
 * ripgrep 通过 @vscode/ripgrep 以平台相关的二进制形式提供。我们直接 shell out 调用，
 * 因为用纯 JS 链接它的 native API 对一个 minimal agent 来说成本太高。
 * 该包把解析后的二进制路径导出为 `rgPath`。
 */
function locateRipgrep(): string {
  if (!rgPath) {
    throw new Error('cannot locate ripgrep binary from @vscode/ripgrep');
  }
  return rgPath;
}

export const searchTool: RegisteredTool = {
  definition: {
    name: 'search',
    description:
      'Regex search across files using ripgrep. Returns matching lines in ' +
      '"file:line: content" format. Use this to locate symbols, TODOs, error strings, ' +
      'or any pattern before reading or editing.',
    schema: SearchArgs,
  },
  handler: async (args, ctx) => {
    const { pattern, path: p, glob, case_insensitive, max_results, context } =
      args as z.infer<typeof SearchArgs>;

    const rg = locateRipgrep();
    const target = p ? safePath(p, ctx.workdir) : ctx.workdir;
    const limit = max_results ?? 100;
    const ctxLines = context ?? 0;

    const args_: string[] = [
      '--no-heading',
      '--line-number',
      '--no-config',
      '--no-messages',
      '--max-columns',
      '500',
      '--max-columns-preview',
    ];
    if (case_insensitive) args_.push('-i');
    if (glob) args_.push('--glob', glob);
    args_.push('-C', String(ctxLines));
    args_.push('-m', String(limit));
    args_.push('--', pattern, target);

    return new Promise<ToolResult>((resolve) => {
      const child = spawn(rg, args_, {
        cwd: ctx.workdir,
        env: process.env,
        windowsHide: true,
      });
      let out = '';
      let err = '';
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
          /* 忽略 */
        }
      }, ctx.timeoutMs);

      child.stdout.on('data', (c: Buffer) => {
        if (out.length < ctx.maxOutputChars) {
          out += c.toString('utf8');
        }
      });
      child.stderr.on('data', (c: Buffer) => {
        if (err.length < Math.floor(ctx.maxOutputChars / 2)) {
          err += c.toString('utf8');
        }
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        // rg exit codes: 0 = match, 1 = no match, 2 = error
        // rg 退出码：0 = 匹配，1 = 无匹配，2 = 错误
        if (killed) {
          resolve({ ok: false, output: err, error: 'timeout' });
          return;
        }
        if (code === 0 || code === 1) {
          resolve({ ok: true, output: truncate(out || '(no matches)', ctx.maxOutputChars) });
          return;
        }
        resolve({ ok: false, output: err, error: `rg_exit:${code}` });
      });

      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ ok: false, output: '', error: `spawn_error: ${e.message}` });
      });
    });
  },
};
