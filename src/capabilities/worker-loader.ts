import type { AgentProfile } from '@flue/runtime';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resolveCapabilityPath } from './capability-loader.js';
import { dynamicImport } from './dynamic-import.js';
import { composeWorkspaceInstructions } from '../workspace-loader.js';
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

      if (existsSync(workspaceDir)) {
        try {
          // Only load workspace files that actually exist — composeWorkspaceInstructions
          // throws on missing files, so we filter to existing ones first.
          const allWorkspaceFiles = [
            'SECURITY.md', 'AGENTS.md', 'IDENTITY.md', 'SOUL.md',
            'USER.md', 'TOOLS.md', 'MEMORY.md', 'HEARTBEAT.md',
          ] as const;
          const existingFiles = allWorkspaceFiles.filter((f) => existsSync(resolve(workspaceDir, f)));
          if (existingFiles.length > 0) {
            workspaceInstructions = composeWorkspaceInstructions({
              workspaceDir,
              title: `Worker ${record.id} Workspace`,
              files: existingFiles,
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[capabilities] Worker ${record.id}: failed to load workspace files: ${message}`);
        }
      } else {
        console.warn(`[capabilities] Worker ${record.id} has no workspace/ directory — all workers should have workspace persona files`);
      }

      for (const profile of loadedProfiles) {
        if (workspaceInstructions) {
          const existingInstructions = profile.instructions ?? '';
          profile.instructions = [workspaceInstructions, existingInstructions].filter(Boolean).join('\n\n');
        }
        profiles.push(profile);
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