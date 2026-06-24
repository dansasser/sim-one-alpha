import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { createCapabilityStore } from '../../../src/capabilities/index.js';
import { resolveCapabilitiesDir, assertSafeCapabilityId } from '../../../src/capabilities/index.js';
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
 * Re-exported from the runtime capability-loader.ts to avoid duplication.
 * Single source of truth for capabilities directory resolution.
 */
export { resolveCapabilitiesDir as getCapabilitiesDir, assertSafeCapabilityId };

/**
 * Resolve the on-disk path for a capability under the capabilities root.
 * Format: `<capabilitiesDir>/<kind>s/<id>` (e.g. `skills/my-skill`).
 */
export function getCapabilityPath(kind: CapabilityKind, id: string): string {
  assertSafeCapabilityId(id);
  return resolve(resolveCapabilitiesDir(), kind + 's', id);
}