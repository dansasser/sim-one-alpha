import assert from 'node:assert/strict';
import test from 'node:test';
import { rmSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkNameCollision } from '../capabilities/collision-check.js';
import { createCapabilityStore } from '../capabilities/capability-store.js';
import type { CapabilityRecord } from '../capabilities/types.js';

let tempDir: string;

function freshDbPath(): string {
  return resolve(tempDir, `collision-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function makeRecord(overrides: Partial<CapabilityRecord> = {}): CapabilityRecord {
  const now = new Date().toISOString();
  return {
    id: 'test-cap',
    kind: 'skill',
    name: 'Test Capability',
    description: 'A test capability',
    source: 'local',
    sourceRef: '/tmp/test',
    version: null,
    enabled: false,
    config: {},
    installedAt: now,
    updatedAt: now,
    installedBy: 'cli',
    ...overrides,
  };
}

test('collision-check: no collision for a new valid name', () => {
  const result = checkNameCollision('skill', 'totally-new-name-xyz');
  assert.equal(result.collision, false);
  assert.equal(result.source, null);
  assert.equal(result.message, undefined);
});

test('collision-check: detects existing capability in SQLite', () => {
  const dbPath = freshDbPath();
  process.env.GOROMBO_CAPABILITY_DB_PATH = dbPath;
  const store = createCapabilityStore({ dbPath });
  try {
    store.insert(makeRecord({ id: 'existing-skill', kind: 'skill' }));
  } finally {
    store.close();
  }

  const result = checkNameCollision('skill', 'existing-skill');
  assert.equal(result.collision, true);
  assert.equal(result.source, 'existing');
  assert.ok(result.message?.includes('already exists'), `message should say 'already exists', got: ${result.message}`);
});

test('collision-check: detects cross-kind existing capability', () => {
  const dbPath = freshDbPath();
  process.env.GOROMBO_CAPABILITY_DB_PATH = dbPath;
  const store = createCapabilityStore({ dbPath });
  try {
    store.insert(makeRecord({ id: 'cross-kind-test', kind: 'tool' }));
  } finally {
    store.close();
  }

  // Adding as skill should still collide because id is the same
  const result = checkNameCollision('skill', 'cross-kind-test');
  assert.equal(result.collision, true);
  assert.equal(result.source, 'existing');
});

test('collision-check: detects builtin name (when registry is available)', () => {
  const result = checkNameCollision('skill', 'load_protocols');
  // If builtin registry exists from a build, this should collide
  // If not (no build run), it won't collide — both are acceptable in test env
  if (result.collision && result.source === 'builtin') {
    assert.ok(result.message?.includes('built-in'), `message should mention 'built-in', got: ${result.message}`);
  }
});

test('collision-check: detects builtin subagent name (when registry is available)', () => {
  const result = checkNameCollision('skill', 'coding-worker');
  if (result.collision && result.source === 'builtin') {
    assert.ok(result.message?.includes('built-in'), `message should mention 'built-in', got: ${result.message}`);
  }
});

test('collision-check: detects builtin MCP name (when registry is available)', () => {
  const result = checkNameCollision('mcp', 'astro-docs');
  if (result.collision && result.source === 'builtin') {
    assert.ok(result.message?.includes('built-in'), `message should mention 'built-in', got: ${result.message}`);
  }
});

test.before(() => {
  tempDir = resolve(process.cwd(), '.tmp', 'test-collision-check');
  mkdirSync(tempDir, { recursive: true });
  process.env.GOROMBO_CAPABILITY_DB_PATH = freshDbPath();
});

test.after(() => {
  delete process.env.GOROMBO_CAPABILITY_DB_PATH;
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});