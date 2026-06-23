import assert from 'node:assert/strict';
import test from 'node:test';
import { rmSync, mkdirSync, existsSync, cpSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadUserWorkers } from '../capabilities/worker-loader.js';
import { createCapabilityStore } from '../capabilities/capability-store.js';
import type { CapabilityRecord } from '../capabilities/types.js';

let tempDir: string;
let tempCapabilitiesDir: string;
let tempDbPath: string;

function makeWorkerRecord(id: string): CapabilityRecord {
  const now = new Date().toISOString();
  return {
    id,
    kind: 'worker',
    name: `Test Worker ${id}`,
    description: 'A test worker',
    source: 'local',
    sourceRef: '/tmp/test',
    version: null,
    enabled: true,
    config: {},
    installedAt: now,
    updatedAt: now,
    installedBy: 'cli',
  };
}

test('worker-loader: loads worker with workspace files', async () => {
  const workerId = 'test-worker-with-ws';
  const workerDir = resolve(tempCapabilitiesDir, 'workers', workerId);
  mkdirSync(workerDir, { recursive: true });
  mkdirSync(resolve(workerDir, 'workspace'), { recursive: true });

  // Copy fixture files
  const fixtureDir = resolve(process.cwd(), 'src', 'tests', 'fixtures', 'capabilities', 'test-worker');
  cpSync(resolve(fixtureDir, 'index.mjs'), resolve(workerDir, 'index.mjs'));
  cpSync(resolve(fixtureDir, 'workspace', 'USER.md'), resolve(workerDir, 'workspace', 'USER.md'));
  cpSync(resolve(fixtureDir, 'workspace', 'TOOLS.md'), resolve(workerDir, 'workspace', 'TOOLS.md'));

  const store = createCapabilityStore({ dbPath: tempDbPath });
  try {
    store.insert(makeWorkerRecord(workerId));
  } finally {
    store.close();
  }

  const records = [makeWorkerRecord(workerId)];
  const result = await loadUserWorkers(records, { GOROMBO_CAPABILITIES_DIR: tempCapabilitiesDir });

  assert.equal(result.profiles.length, 1, 'should load 1 profile');
  assert.equal(result.profiles[0].name, 'test-worker', 'profile name should match');
  assert.ok(result.profiles[0].instructions, 'profile should have instructions');
  assert.ok(
    result.profiles[0].instructions.includes('test worker'),
    `instructions should include workspace content, got: ${result.profiles[0].instructions?.slice(0, 200)}`,
  );
  assert.equal(result.errors.length, 0, 'should have no errors');
});

test('worker-loader: loads worker without workspace (with warning)', async () => {
  const workerId = 'test-worker-no-ws';
  const workerDir = resolve(tempCapabilitiesDir, 'workers', workerId);
  mkdirSync(workerDir, { recursive: true });

  // Only index.mjs, no workspace/
  const fixtureDir = resolve(process.cwd(), 'src', 'tests', 'fixtures', 'capabilities', 'test-worker');
  cpSync(resolve(fixtureDir, 'index.mjs'), resolve(workerDir, 'index.mjs'));

  const store = createCapabilityStore({ dbPath: tempDbPath });
  try {
    store.insert(makeWorkerRecord(workerId));
  } finally {
    store.close();
  }

  const records = [makeWorkerRecord(workerId)];
  const result = await loadUserWorkers(records, { GOROMBO_CAPABILITIES_DIR: tempCapabilitiesDir });

  assert.equal(result.profiles.length, 1, 'should still load 1 profile');
  assert.equal(result.profiles[0].name, 'test-worker', 'profile name should match');
  assert.equal(result.errors.length, 0, 'should have no errors (missing workspace is a warning, not an error)');
});

test('worker-loader: reports error for invalid module', async () => {
  const workerId = 'test-worker-bad';
  const workerDir = resolve(tempCapabilitiesDir, 'workers', workerId);
  mkdirSync(workerDir, { recursive: true });

  // Write an invalid module (no defineAgentProfile export)
  const { writeFileSync } = await import('node:fs');
  writeFileSync(resolve(workerDir, 'index.mjs'), 'export default {};\n');

  const records = [makeWorkerRecord(workerId)];
  const result = await loadUserWorkers(records, { GOROMBO_CAPABILITIES_DIR: tempCapabilitiesDir });

  assert.equal(result.profiles.length, 0, 'should load 0 profiles');
  assert.ok(result.errors.length >= 1, 'should report at least 1 error');
});

test('worker-loader: returns empty for empty input', async () => {
  const result = await loadUserWorkers([], { GOROMBO_CAPABILITIES_DIR: tempCapabilitiesDir });
  assert.equal(result.profiles.length, 0);
  assert.equal(result.errors.length, 0);
});

test.before(() => {
  tempDir = resolve(process.cwd(), '.tmp', 'test-worker-loader');
  tempCapabilitiesDir = resolve(tempDir, 'capabilities');
  tempDbPath = resolve(tempDir, 'capabilities-worker-test.sqlite');
  mkdirSync(tempDir, { recursive: true });
  mkdirSync(tempCapabilitiesDir, { recursive: true });
});

test.after(() => {
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});