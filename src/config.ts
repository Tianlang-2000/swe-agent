import 'dotenv/config';
import process from 'node:process';

export type LLMProvider = 'deepseek' | 'minimax';

export interface AgentConfig {
  provider: LLMProvider;
  apiKey: string;
  baseURL: string;
  model: string;
  maxSteps: number;
  toolTimeoutMs: number;
  maxOutputChars: number;
  workdir: string;
}

function pickProvider(): LLMProvider {
  const raw = (process.env.LLM_PROVIDER ?? 'deepseek').toLowerCase().trim();
  if (raw === 'minimax') return 'minimax';
  return 'deepseek';
}

export function loadConfig(): AgentConfig {
  const provider = pickProvider();

  if (provider === 'deepseek') {
    const apiKey = process.env.DEEPSEEK_API_KEY ?? '';
    if (!apiKey) {
      throw new Error('DEEPSEEK_API_KEY is not set. Copy .env.example to .env and fill it in.');
    }
    return {
      provider,
      apiKey,
      baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1',
      model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
      maxSteps: parseInt(process.env.MAX_STEPS ?? '40', 10),
      toolTimeoutMs: parseInt(process.env.TOOL_TIMEOUT_MS ?? '60000', 10),
      maxOutputChars: parseInt(process.env.MAX_OUTPUT_CHARS ?? '50000', 10),
      workdir: process.env.WORKDIR ?? '.',
    };
  }

  const apiKey = process.env.MINIMAX_API_KEY ?? '';
  if (!apiKey) {
    throw new Error('MINIMAX_API_KEY is not set. Copy .env.example to .env and fill it in.');
  }
  return {
    provider,
    apiKey,
    baseURL: process.env.MINIMAX_BASE_URL ?? 'https://api.minimaxi.com/v1',
    model: process.env.MINIMAX_MODEL ?? 'MiniMax-Text-01',
    maxSteps: parseInt(process.env.MAX_STEPS ?? '40', 10),
    toolTimeoutMs: parseInt(process.env.TOOL_TIMEOUT_MS ?? '60000', 10),
    maxOutputChars: parseInt(process.env.MAX_OUTPUT_CHARS ?? '50000', 10),
    workdir: process.env.WORKDIR ?? '.',
  };
}
