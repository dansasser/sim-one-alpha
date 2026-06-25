import type { ToolDefinition } from '@flue/runtime';
import { resolveCapabilityPath } from '../../engine/capabilities/capability-loader.js';
import { dynamicImport } from '../../engine/capabilities/dynamic-import.js';
import type { CapabilityRecord } from '../../engine/capabilities/types.js';

export interface ToolLoaderResult {
  tools: ToolDefinition[];
  errors: Array<{ id: string; error: string }>;
}

export async function loadUserTools(
  toolRecords: CapabilityRecord[],
  env: Record<string, unknown> = process.env,
): Promise<ToolLoaderResult> {
  const tools: ToolDefinition[] = [];
  const errors: Array<{ id: string; error: string }> = [];

  for (const record of toolRecords) {
    const modulePath = resolveCapabilityPath(env, 'tool', record.id) + '/index.mjs';
    try {
      const mod = await dynamicImport(modulePath);
      const exported = mod?.default ?? mod;
      if (Array.isArray(exported)) {
        for (const item of exported) {
          if (isToolLike(item)) {
            tools.push(item);
          }
        }
      } else if (isToolLike(exported)) {
        tools.push(exported);
      } else if (typeof mod === 'object' && mod !== null) {
        for (const value of Object.values(mod)) {
          if (isToolLike(value)) {
            tools.push(value as ToolDefinition);
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ id: record.id, error: message });
      console.error(`[capabilities] Tool loader failed for ${record.id}: ${message}`);
    }
  }

  return { tools, errors };
}

function isToolLike(value: unknown): value is ToolDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof (value as { name: unknown }).name === 'string' &&
    'execute' in value &&
    typeof (value as { execute: unknown }).execute === 'function'
  );
}