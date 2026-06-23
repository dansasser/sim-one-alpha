import { isAbsolute, resolve } from 'node:path';
import type { CapabilityKind, CapabilityRecord, CapabilityStore } from './types.js';

export interface LoadedUserCapabilities {
  skills: CapabilityRecord[];
  tools: CapabilityRecord[];
  workers: CapabilityRecord[];
  mcp: CapabilityRecord[];
}

export interface CapabilityLoaderOptions {
  store: CapabilityStore;
}

export function loadUserCapabilities(options: CapabilityLoaderOptions): LoadedUserCapabilities {
  const { store } = options;
  const all = store.list({ enabledOnly: true });

  return {
    skills: all.filter((r) => r.kind === 'skill'),
    tools: all.filter((r) => r.kind === 'tool'),
    workers: all.filter((r) => r.kind === 'worker'),
    mcp: all.filter((r) => r.kind === 'mcp'),
  };
}

export function resolveCapabilitiesDir(env: Record<string, unknown> = process.env): string {
  const configured =
    readEnv(env, 'GOROMBO_CAPABILITIES_DIR') ??
    readEnv(env, 'GOROMBO_CAPABILITY_DIR');

  if (configured) {
    return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
  }

  return resolve(process.cwd(), '.gorombo', 'capabilities');
}

export function resolveCapabilityPath(
  env: Record<string, unknown>,
  kind: CapabilityKind,
  id: string,
): string {
  return resolve(resolveCapabilitiesDir(env), kind + 's', id);
}

function readEnv(env: Record<string, unknown>, key: string): string | undefined {
  const value = env[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}