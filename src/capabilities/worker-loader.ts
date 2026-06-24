import type { AgentProfile } from '@flue/runtime';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resolveCapabilityPath } from './capability-loader.js';
import { dynamicImport } from './dynamic-import.js';
import { composeWorkspaceInstructions, workspaceFileOrder } from '../workspace-loader.js';
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
      const loadedProfiles: AgentProfile[] = [];

      if (Array.isArray(exported)) {
        for (const item of exported) {
          if (isProfileLike(item)) {
            loadedProfiles.push(item);
          }
        }
      } else if (isProfileLike(exported)) {
        loadedProfiles.push(exported);
      } else if (typeof mod === 'object' && mod !== null) {
        for (const value of Object.values(mod)) {
          if (isProfileLike(value)) {
            loadedProfiles.push(value as AgentProfile);
          }
        }
      }

      if (loadedProfiles.length === 0) {
        const message = `No agent profiles found in worker module ${modulePath}. Expected a default export, array export, or named exports of defineAgentProfile(...) results.`;
        errors.push({ id: record.id, error: message });
        console.error(`[capabilities] Worker loader: ${message}`);
        continue;
      }

      const workspaceDir = resolve(dirname(modulePath), 'workspace');
      let workspaceInstructions: string | undefined;

      if (!existsSync(workspaceDir)) {
        const message = `Worker ${record.id} has no workspace/ directory — all workers must have workspace persona files`;
        errors.push({ id: record.id, error: message });
        console.error(`[capabilities] Worker loader: ${message}`);
        continue;
      }

      try {
        const existingFiles = workspaceFileOrder.filter((f) => existsSync(resolve(workspaceDir, f)));
        if (existingFiles.length === 0) {
          const message = `Worker ${record.id} workspace/ directory exists but contains no recognized persona files`;
          errors.push({ id: record.id, error: message });
          console.error(`[capabilities] Worker loader: ${message}`);
          continue;
        }
        workspaceInstructions = composeWorkspaceInstructions({
          workspaceDir,
          title: `Worker ${record.id} Workspace`,
          files: existingFiles,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ id: record.id, error: `Failed to load workspace files: ${message}` });
        console.error(`[capabilities] Worker ${record.id}: failed to load workspace files: ${message}`);
        continue;
      }

      for (const profile of loadedProfiles) {
        const existingInstructions = profile.instructions ?? '';
        const mergedInstructions = [workspaceInstructions, existingInstructions].filter(Boolean).join('\n\n');
        profiles.push({
          ...profile,
          instructions: mergedInstructions,
        });
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