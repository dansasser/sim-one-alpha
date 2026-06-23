import { existsSync, rmSync } from 'node:fs';
import { checkNameCollision } from '../../../src/capabilities/index.js';
import type { CapabilityRecord } from '../../../src/capabilities/index.js';
import {
  assertSafeCapabilityId,
  getCapabilityPath,
  withStore,
} from './store.js';
import { fetchSource, refetchCapability } from './skill.js';

const KIND = 'worker' as const;

/**
 * Add (or overwrite) a worker capability: fetch the source (github clone or
 * local copy), materialize it under the capabilities directory, and insert a
 * row into SQLite.
 *
 * Workers default to disabled unless `--enable` is requested.
 */
export function addWorker(
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

  const { fetchedSource, sourceRef } = fetchSource(source, KIND, id);
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
      `Added worker capability ${id}. ${enable ? 'Enabled.' : `Disabled — run \`sim-one worker enable ${id}\` to activate.`}`,
    );
  });
}

/**
 * List all worker capabilities (as JSON).
 */
export function listWorkers(): void {
  withStore((store) => {
    const rows = store.list({ kind: KIND });
    console.log(JSON.stringify(rows, null, 2));
  });
}

/**
 * Enable a worker capability.
 */
export function enableWorker(id: string): void {
  assertSafeCapabilityId(id);
  withStore((store) => {
    const before = store.get(KIND, id);
    store.setEnabled(KIND, id, true);
    console.log(before ? `Enabled worker ${id}.` : `No worker capability found for ${id}.`);
  });
}

/**
 * Disable a worker capability.
 */
export function disableWorker(id: string): void {
  assertSafeCapabilityId(id);
  withStore((store) => {
    const before = store.get(KIND, id);
    store.setEnabled(KIND, id, false);
    console.log(before ? `Disabled worker ${id}.` : `No worker capability found for ${id}.`);
  });
}

/**
 * Remove a worker capability: delete its SQLite row and remove its capability
 * files (if present).
 */
export function removeWorker(id: string): void {
  assertSafeCapabilityId(id);
  withStore((store) => {
    const capPath = getCapabilityPath(KIND, id);
    if (existsSync(capPath)) {
      rmSync(capPath, { recursive: true, force: true });
    }
    const removed = store.remove(KIND, id);
    console.log(removed ? `Removed worker ${id}.` : `No worker capability found for ${id}.`);
  });
}

/**
 * Re-fetch a worker capability from its recorded source and bump `updated_at`.
 */
export function updateWorker(id: string): void {
  assertSafeCapabilityId(id);
  withStore((store) => {
    const record = store.get(KIND, id);
    if (!record) {
      console.log(`No worker capability found for ${id}.`);
      return;
    }
    refetchCapability(store, KIND, record);
  });
}