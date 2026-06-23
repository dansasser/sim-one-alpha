import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { createCapabilityStore } from '../../../src/capabilities/index.js';
import type { CapabilityKind, CapabilityStore } from '../../../src/capabilities/index.js';

/**
 * Resolve the capability SQLite database path using the same rules as the
 * runtime {@link createCapabilityStore}: honor `GOROMBO_CAPABILITY_DB_PATH`
 * (default `.gorombo/db/capabilities.sqlite`), resolving relative to
 * `process.cwd()` when not absolute.
 */
export function resolveCapabilityDbPath(env: Record<string, unknown> = process.env): string {
  const configured =
    typeof env.GOROMBO_CAPABILITY_DB_PATH === 'string'
      ? env.GOROMBO_CAPABILITY_DB_PATH.trim()
      : undefined;
  const rawPath = configured ?? resolve(homedir(), '.gorombo', 'db', 'capabilities.sqlite');
  return isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath);
}

/**
 * Create a {@link CapabilityStore} backed by the SQLite database resolved
 * from the environment. The directory is created if missing.
 */
export function createStore(): CapabilityStore {
  return createCapabilityStore({ dbPath: resolveCapabilityDbPath() });
}

/**
 * Run an operation against a fresh {@link CapabilityStore} and close it when
 * done, even on errors. Exits with code 1 on uncaught errors.
 */
export function withStore<T>(fn: (store: CapabilityStore) => T): T {
  const store = createStore();
  try {
    return fn(store);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  } finally {
    store.close();
  }
}

/**
 * Resolve the capabilities root directory using the same rules as
 * `capability-loader.ts`: honor `GOROMBO_CAPABILITIES_DIR` /
 * `GOROMBO_CAPABILITY_DIR` (default `~/.gorombo/capabilities`), resolving
 * relative to `process.cwd()` when not absolute.
 */
export function getCapabilitiesDir(env: Record<string, unknown> = process.env): string {
  const configured =
    readEnv(env, 'GOROMBO_CAPABILITIES_DIR') ?? readEnv(env, 'GOROMBO_CAPABILITY_DIR');
  if (configured) {
    return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
  }
  return resolve(homedir(), '.gorombo', 'capabilities');
}

/**
 * Reject capability ids that could escape the capabilities root via path
 * traversal or absolute paths. Capability ids are opaque slugs, never
 * filesystem paths.
 */
export function assertSafeCapabilityId(id: string): void {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Invalid capability id: empty');
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

/**
 * Resolve the on-disk path for a capability under the capabilities root.
 * Format: `<capabilitiesDir>/<kind>s/<id>` (e.g. `skills/my-skill`).
 */
export function getCapabilityPath(kind: CapabilityKind, id: string): string {
  assertSafeCapabilityId(id);
  return resolve(getCapabilitiesDir(), kind + 's', id);
}

function readEnv(env: Record<string, unknown>, key: string): string | undefined {
  const value = env[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}