import assert from 'node:assert/strict';
import test from 'node:test';
import { rmSync, mkdirSync, mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkNameCollision } from '../capabilities/collision-check.js';
import { resetBuiltinRegistryCache } from '../capabilities/builtin-registry.js';
import { createCapabilityStore } from '../capabilities/capability-store.js';
import type { CapabilityRecord } from '../capabilities/types.js';

let tempDir: string;
let originalCwd: string;

function freshDbPath(): string {
  return resolve(tempDir, `collision-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
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

function setupFixtureRegistry() {
  const distDir = resolve(tempDir, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    resolve(distDir, 'builtin-capabilities.json'),
    JSON.stringify({
      tools: ['load_protocols', 'retrieve_memory', 'test_echo'],
      subagents: ['coding-worker', 'researcher'],
      skills: ['chat.route-basic'],
      mcpServers: ['astro-docs'],
    }),
  );
}

test('collision-check: no collision for a new valid name', () => {
  process.env.GOROMBO_CAPABILITY_DB_PATH = freshDbPath();
  const result = checkNameCollision('skill', 'totally-new-name-xyz');
  assert.equal(result.collision, false);
  assert.equal(result.source, null);
  assert.equal(result.message, undefined);
});

test('collision-check: detects existing capability in SQLite (same kind)', () => {
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

  const result = checkNameCollision('skill', 'cross-kind-test');
  assert.equal(result.collision, true);
  assert.equal(result.source, 'existing');
  assert.ok(result.message?.includes('already exists'), `message should include 'already exists'`);
});

test('collision-check: detects builtin tool name (load_protocols)', () => {
  process.env.GOROMBO_CAPABILITY_DB_PATH = freshDbPath();
  const result = checkNameCollision('skill', 'load_protocols');
  assert.equal(result.collision, true);
  assert.equal(result.source, 'builtin');
  assert.ok(result.message?.includes('built-in'), `message should mention 'built-in', got: ${result.message}`);
});

test('collision-check: detects builtin subagent name (coding-worker)', () => {
  process.env.GOROMBO_CAPABILITY_DB_PATH = freshDbPath();
  const result = checkNameCollision('skill', 'coding-worker');
  assert.equal(result.collision, true);
  assert.equal(result.source, 'builtin');
  assert.ok(result.message?.includes('built-in'), `message should mention 'built-in'`);
});

test('collision-check: detects builtin MCP name (astro-docs)', () => {
  process.env.GOROMBO_CAPABILITY_DB_PATH = freshDbPath();
  const result = checkNameCollision('mcp', 'astro-docs');
  assert.equal(result.collision, true);
  assert.equal(result.source, 'builtin');
  assert.ok(result.message?.includes('built-in'), `message should mention 'built-in'`);
});

test.before(() => {
  resetBuiltinRegistryCache();
  tempDir = mkdtempSync(join(tmpdir(), 'collision-check-test-'));
  originalCwd = process.cwd();
  setupFixtureRegistry();
  process.chdir(tempDir);
});

test.after(() => {
  delete process.env.GOROMBO_CAPABILITY_DB_PATH;
  resetBuiltinRegistryCache();
  process.chdir(originalCwd);
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});