import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import type { CapabilityKind, CapabilityRecord } from './types.js';
import { resolveCapabilityPath } from './capability-loader.js';

export interface MaterializeOptions {
  record: CapabilityRecord;
  env?: Record<string, unknown>;
}

export interface MaterializeResult {
  path: string;
  action: 'cloned' | 'copied' | 'skipped' | 'removed';
}

export function materializeCapability(options: MaterializeOptions): MaterializeResult {
  const { record, env = process.env } = options;
  const targetPath = resolveCapabilityPath(env, record.kind, record.id);

  if (!record.enabled) {
    if (existsSync(targetPath)) {
      rmSync(targetPath, { recursive: true, force: true });
      return { path: targetPath, action: 'removed' };
    }
    return { path: targetPath, action: 'skipped' };
  }

  mkdirSync(dirname(targetPath), { recursive: true });

  switch (record.source) {
    case 'github':
      return materializeFromGithub(record, targetPath);
    case 'local':
      return materializeFromLocal(record, targetPath);
    default:
      return { path: targetPath, action: 'skipped' };
  }
}

function materializeFromGithub(record: CapabilityRecord, targetPath: string): MaterializeResult {
  if (existsSync(targetPath)) {
    rmSync(targetPath, { recursive: true, force: true });
  }

  execSync(`git clone --depth 1 ${shellQuote(record.sourceRef)} ${shellQuote(targetPath)}`, {
    stdio: 'pipe',
    timeout: 30_000,
  });

  if (record.version && record.version !== 'latest') {
    try {
      execSync(`git -C ${shellQuote(targetPath)} checkout ${shellQuote(record.version)}`, {
        stdio: 'pipe',
        timeout: 10_000,
      });
    } catch (error) {
      rmSync(resolve(targetPath, '.git'), { recursive: true, force: true });
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to pin version "${record.version}" for capability "${record.id}": ${message}`);
    }
  }

  rmSync(resolve(targetPath, '.git'), { recursive: true, force: true });
  return { path: targetPath, action: 'cloned' };
}

function materializeFromLocal(record: CapabilityRecord, targetPath: string): MaterializeResult {
  const sourcePath = isAbsolute(record.sourceRef)
    ? record.sourceRef
    : resolve(process.cwd(), record.sourceRef);

  if (!existsSync(sourcePath)) {
    throw new Error(`Local capability source not found: ${sourcePath}`);
  }

  if (existsSync(targetPath)) {
    rmSync(targetPath, { recursive: true, force: true });
  }

  cpSync(sourcePath, targetPath, { recursive: true, force: true });
  return { path: targetPath, action: 'copied' };
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}