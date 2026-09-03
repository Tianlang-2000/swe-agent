import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolDefinition, OpenAITool } from '../types.js';

/**
 * Convert a Zod schema into the OpenAI-compatible tool definition.
 * We strip the $schema field that zod-to-json-schema adds by default —
 * most OpenAI-compatible APIs reject it.
 */
/**
 * 把 Zod schema 转换为 OpenAI 兼容的工具定义。
 * 去掉 zod-to-json-schema 默认添加的 $schema 字段——
 * 大多数 OpenAI 兼容 API 会拒绝它。
 */
export function toOpenAITool(def: ToolDefinition): OpenAITool {
  const json = zodToJsonSchema(def.schema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as Record<string, unknown>;

  // zod-to-json-schema may emit $schema at the top level; strip it.
  // zod-to-json-schema 可能会在顶层输出 $schema 字段；这里直接删掉。
  delete json.$schema;

  return {
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: json as OpenAITool['function']['parameters'],
    },
  };
}
