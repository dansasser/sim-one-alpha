import { existsSync, rmSync } from 'node:fs';
import { checkNameCollision } from '../../../src/capabilities/index.js';
import type { CapabilityRecord } from '../../../src/capabilities/index.js';
import {
  assertSafeCapabilityId,
  getCapabilityPath,
  withStore,
} from './store.js';
import { fetchSource, refetchCapability } from './skill.js';

const KIND = 'tool' as const;

/**
 * Add (or overwrite) a tool capability: fetch the source (github clone or
 * local copy), materialize it under the capabilities directory, and insert a
 * row into SQLite.
 *
 * Tools default to disabled unless `--enable` is requested.
 */
export function addTool(
  source: string,
  id: string,
  name: string,
  description = '',
  enable = false,
  version?: string,
): void {
  assertSafeCapabilityId(id);

  const collision = checkNameCollision(KIND, id);
  if (collision.collision) {
    console.error(`Error: ${collision.message}`);
    process.exit(1);
  }

  const { fetchedSource, sourceRef } = fetchSource(source, KIND, id, version);
  const now = new Date().toISOString();
  const record: CapabilityRecord = {
    id,
    kind: KIND,
    name,
    description,
    source: fetchedSource,
    sourceRef,
    version: version ?? null,
    enabled: enable,
    config: {},
    installedAt: now,
    updatedAt: now,
    installedBy: 'cli',
  };

  withStore((store) => {
    store.insert(record);
    console.log(
      `Added tool capability ${id}. ${enable ? 'Enabled.' : `Disabled — run \`sim-one tool enable ${id}\` to activate.`}`,
    );
  });
}

/**
 * List all tool capabilities (as JSON).
 */
export function listTools(): void {
  withStore((store) => {
    const rows = store.list({ kind: KIND });
    console.log(JSON.stringify(rows, null, 2));
  });
}

/**
 * Enable a tool capability.
 */
export function enableTool(id: string): void {
  assertSafeCapabilityId(id);
  withStore((store) => {
    const before = store.get(KIND, id);
    store.setEnabled(KIND, id, true);
    console.log(before ? `Enabled tool ${id}.` : `No tool capability found for ${id}.`);
  });
}

/**
 * Disable a tool capability.
 */
export function disableTool(id: string): void {
  assertSafeCapabilityId(id);
  withStore((store) => {
    const before = store.get(KIND, id);
    store.setEnabled(KIND, id, false);
    console.log(before ? `Disabled tool ${id}.` : `No tool capability found for ${id}.`);
  });
}

/**
 * Remove a tool capability: delete its SQLite row and remove its capability
 * files (if present).
 */
export function removeTool(id: string): void {
  assertSafeCapabilityId(id);
  withStore((store) => {
    const capPath = getCapabilityPath(KIND, id);
    if (existsSync(capPath)) {
      rmSync(capPath, { recursive: true, force: true });
    }
    const removed = store.remove(KIND, id);
    console.log(removed ? `Removed tool ${id}.` : `No tool capability found for ${id}.`);
  });
}

/**
 * Re-fetch a tool capability from its recorded source and bump `updated_at`.
 */
export function updateTool(id: string): void {
  assertSafeCapabilityId(id);
  withStore((store) => {
    const record = store.get(KIND, id);
    if (!record) {
      console.log(`No tool capability found for ${id}.`);
      return;
    }
    refetchCapability(store, KIND, record);
  });
}