import { homedir } from 'node:os';
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

  return resolve(homedir(), '.gorombo', 'capabilities');
}

export function resolveCapabilityPath(
  env: Record<string, unknown>,
  kind: CapabilityKind,
  id: string,
): string {
  assertSafeCapabilityId(id);
  return resolve(resolveCapabilitiesDir(env), kind + 's', id);
}

/**
 * Reject capability ids that could escape the capabilities root via path
 * traversal or absolute paths. Capability ids are opaque slugs (e.g.
 * "my-jira-skill"), never filesystem paths.
 */
export function assertSafeCapabilityId(id: string): void {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`Invalid capability id: empty`);
  }
  if (id.includes('/') || id.includes('\\') || id.includes('\0')) {
    throw new Error(`Invalid capability id "${id}": must not contain path separators`);
  }
  if (id === '.' || id === '..' || id.includes('..')) {
    throw new Error(`Invalid capability id "${id}": must not contain traversal sequences`);
  }
  if (isAbsolute(id)) {
    throw new Error(`Invalid capability id "${id}": must not be an absolute path`);
  }
}

function readEnv(env: Record<string, unknown>, key: string): string | undefined {
  const value = env[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}