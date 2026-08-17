import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolDefinition, OpenAITool } from '../types.js';

/**
 * Convert a Zod schema into the OpenAI-compatible tool definition.
 * We strip the $schema field that zod-to-json-schema adds by default —
 * most OpenAI-compatible APIs reject it.
 */
export function toOpenAITool(def: ToolDefinition): OpenAITool {
  const json = zodToJsonSchema(def.schema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as Record<string, unknown>;

  // zod-to-json-schema may emit $schema at the top level; strip it.
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
