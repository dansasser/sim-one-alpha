import type { AgentProfile } from '@flue/runtime';
import { resolveCapabilityPath } from './capability-loader.js';
import { dynamicImport } from './dynamic-import.js';
import type { CapabilityRecord } from './types.js';

export interface WorkerLoaderResult {
  profiles: AgentProfile[];
  errors: Array<{ id: string; error: string }>;
}

export async function loadUserWorkers(
  workerRecords: CapabilityRecord[],
  env: Record<string, unknown> = process.env,
): Promise<WorkerLoaderResult> {
  const profiles: AgentProfile[] = [];
  const errors: Array<{ id: string; error: string }> = [];

  for (const record of workerRecords) {
    const modulePath = resolveCapabilityPath(env, 'worker', record.id) + '/index.mjs';
    try {
      const mod = await dynamicImport(modulePath);
      const exported = mod?.default ?? mod;
      if (Array.isArray(exported)) {
        for (const item of exported) {
          if (isProfileLike(item)) {
            profiles.push(item);
          }
        }
      } else if (isProfileLike(exported)) {
        profiles.push(exported);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ id: record.id, error: message });
      console.error(`[capabilities] Worker loader failed for ${record.id}: ${message}`);
    }
  }

  return { profiles, errors };
}

function isProfileLike(value: unknown): value is AgentProfile {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof (value as { name: unknown }).name === 'string'
  );
}