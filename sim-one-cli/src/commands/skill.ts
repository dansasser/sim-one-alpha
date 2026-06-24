import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  checkNameCollision,
} from '../../../src/capabilities/index.js';
import type { CapabilityRecord, CapabilitySource, CapabilityStore } from '../../../src/capabilities/index.js';
import {
  assertSafeCapabilityId,
  getCapabilityPath,
  withStore,
} from './store.js';

const KIND = 'skill' as const;

/**
 * Add (or overwrite) a skill capability: fetch the source (github clone or
 * local copy), materialize it under the capabilities directory, and insert a
 * row into SQLite.
 *
 * Skills default to enabled unless `--disable` is requested.
 */
export function addSkill(
  source: string,
  id: string,
  name: string,
  description = '',
  enable = true,
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
      `Added skill capability ${id}. ${enable ? 'Enabled.' : `Disabled — run \`sim-one skill enable ${id}\` to activate.`}`,
    );
  });
}

/**
 * List all skill capabilities (as JSON).
 */
export function listSkills(): void {
  withStore((store) => {
    const rows = store.list({ kind: KIND });
    console.log(JSON.stringify(rows, null, 2));
  });
}

/**
 * Enable a skill capability.
 */
export function enableSkill(id: string): void {
  assertSafeCapabilityId(id);
  withStore((store) => {
    const before = store.get(KIND, id);
    store.setEnabled(KIND, id, true);
    if (before) {
      console.log(`Enabled skill ${id}.`);
    } else {
      console.log(`No skill capability found for ${id}.`);
    }
  });
}

/**
 * Disable a skill capability.
 */
export function disableSkill(id: string): void {
  assertSafeCapabilityId(id);
  withStore((store) => {
    const before = store.get(KIND, id);
    store.setEnabled(KIND, id, false);
    if (before) {
      console.log(`Disabled skill ${id}.`);
    } else {
      console.log(`No skill capability found for ${id}.`);
    }
  });
}

/**
 * Remove a skill capability: delete its SQLite row and remove its capability
 * files (if present).
 */
export function removeSkill(id: string): void {
  assertSafeCapabilityId(id);
  withStore((store) => {
    const capPath = getCapabilityPath(KIND, id);
    if (existsSync(capPath)) {
      rmSync(capPath, { recursive: true, force: true });
    }
    const removed = store.remove(KIND, id);
    console.log(removed ? `Removed skill ${id}.` : `No skill capability found for ${id}.`);
  });
}

/**
 * Re-fetch a skill capability from its recorded source (github clone or local
 * copy) and bump its `updated_at` timestamp.
 */
export function updateSkill(id: string): void {
  assertSafeCapabilityId(id);
  withStore((store) => {
    const record = store.get(KIND, id);
    if (!record) {
      console.log(`No skill capability found for ${id}.`);
      return;
    }
    refetchCapability(store, KIND, record);
  });
}

/**
 * Shared source fetch used by skill/tool/worker `add`. Returns the
 * {@link CapabilitySource} ("github" | "local") and the normalized
 * `sourceRef` to persist.
 */
export function fetchSource(
  sourceRef: string,
  kind: 'skill' | 'tool' | 'worker',
  id: string,
): { fetchedSource: CapabilitySource; sourceRef: string } {
  assertSafeCapabilityId(id);
  const targetPath = getCapabilityPath(kind, id);
  mkdirSync(dirname(targetPath), { recursive: true });

  if (existsSync(targetPath)) {
    rmSync(targetPath, { recursive: true, force: true });
  }

  if (
    sourceRef.startsWith('http://') ||
    sourceRef.startsWith('https://') ||
    sourceRef.startsWith('git@')
  ) {
    execFileSync('git', ['clone', '--depth', '1', sourceRef, targetPath], {
      stdio: 'pipe',
      timeout: 30_000,
    });
    rmSync(resolve(targetPath, '.git'), { recursive: true, force: true });
    return { fetchedSource: 'github', sourceRef };
  }

  if (existsSync(sourceRef)) {
    const absSource = isAbsolute(sourceRef) ? sourceRef : resolve(process.cwd(), sourceRef);
    cpSync(absSource, targetPath, { recursive: true, force: true });
    return { fetchedSource: 'local', sourceRef: absSource };
  }

  throw new Error(`Cannot resolve source: ${sourceRef}`);
}

/**
 * Re-fetch an existing capability from its recorded `sourceRef` and bump
 * `updated_at`. Shared by skill/tool/worker `update`.
 */
export function refetchCapability(
  store: CapabilityStore,
  kind: 'skill' | 'tool' | 'worker',
  record: CapabilityRecord,
): void {
  const { id, sourceRef } = record;
  const targetPath = getCapabilityPath(kind, id);
  mkdirSync(dirname(targetPath), { recursive: true });

  const isGithub =
    sourceRef.startsWith('http://') ||
    sourceRef.startsWith('https://') ||
    sourceRef.startsWith('git@');

  const stagingDir = mkdtempSync(resolve(tmpdir(), `sim-one-${kind}-`));
  try {
    const stagedPath = resolve(stagingDir, id);

    if (isGithub) {
      execFileSync('git', ['clone', '--depth', '1', sourceRef, stagedPath], {
        stdio: 'pipe',
        timeout: 30_000,
      });
      rmSync(resolve(stagedPath, '.git'), { recursive: true, force: true });
    } else if (existsSync(sourceRef)) {
      const absSource = isAbsolute(sourceRef) ? sourceRef : resolve(process.cwd(), sourceRef);
      cpSync(absSource, stagedPath, { recursive: true, force: true });
    } else {
      throw new Error(`Source not found: ${sourceRef}`);
    }

    if (existsSync(targetPath)) {
      rmSync(targetPath, { recursive: true, force: true });
    }
    cpSync(stagedPath, targetPath, { recursive: true, force: true });
    rmSync(stagingDir, { recursive: true, force: true });

    store.update(kind, id, {});
    if (isGithub) {
      console.log(`Updated ${kind} ${id} from GitHub.`);
    } else {
      console.log(`Updated ${kind} ${id} from local path.`);
    }
  } catch (err) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }
}