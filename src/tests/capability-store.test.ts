import assert from 'node:assert/strict';
import test from 'node:test';
import { rmSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCapabilityStore } from '../capabilities/capability-store.js';
import type { CapabilityRecord } from '../capabilities/types.js';

let tempDbPath: string;
let tempDir: string;

function freshStore() {
  // Each test gets a fresh DB to avoid cross-test contamination
  const dbPath = resolve(tempDir, `cap-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  return createCapabilityStore({ dbPath });
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

test('capability-store: insert and get', () => {
  const store = freshStore();
  try {
    const record = makeRecord({ id: 'insert-test' });
    store.insert(record);
    const got = store.get('skill', 'insert-test');
    assert.ok(got, 'store.get should return the inserted record');
    assert.equal(got.id, 'insert-test');
    assert.equal(got.name, 'Test Capability');
    assert.equal(got.enabled, false);
  } finally {
    store.close();
  }
});

test('capability-store: upsert (insert same id updates)', () => {
  const store = freshStore();
  try {
    store.insert(makeRecord({ id: 'upsert-test', name: 'Original' }));
    store.insert(makeRecord({ id: 'upsert-test', name: 'Updated', enabled: true }));
    const got = store.get('skill', 'upsert-test');
    assert.ok(got, 'store.get should return the upserted record');
    assert.equal(got.name, 'Updated');
    assert.equal(got.enabled, true);
  } finally {
    store.close();
  }
});

test('capability-store: list all', () => {
  const store = freshStore();
  try {
    store.insert(makeRecord({ id: 'list-a', kind: 'skill' }));
    store.insert(makeRecord({ id: 'list-b', kind: 'tool' }));
    store.insert(makeRecord({ id: 'list-c', kind: 'mcp' }));
    const all = store.list();
    assert.equal(all.length, 3);
  } finally {
    store.close();
  }
});

test('capability-store: list filtered by kind', () => {
  const store = freshStore();
  try {
    store.insert(makeRecord({ id: 'kind-skill', kind: 'skill' }));
    store.insert(makeRecord({ id: 'kind-tool', kind: 'tool' }));
    store.insert(makeRecord({ id: 'kind-mcp', kind: 'mcp' }));
    const skills = store.list({ kind: 'skill' });
    assert.equal(skills.length, 1);
    assert.equal(skills[0].id, 'kind-skill');
    const tools = store.list({ kind: 'tool' });
    assert.equal(tools.length, 1);
    assert.equal(tools[0].id, 'kind-tool');
  } finally {
    store.close();
  }
});

test('capability-store: list enabled only', () => {
  const store = freshStore();
  try {
    store.insert(makeRecord({ id: 'enabled-yes', enabled: true }));
    store.insert(makeRecord({ id: 'enabled-no', enabled: false }));
    const enabled = store.list({ enabledOnly: true });
    assert.equal(enabled.length, 1);
    assert.equal(enabled[0].id, 'enabled-yes');
  } finally {
    store.close();
  }
});

test('capability-store: setEnabled', () => {
  const store = freshStore();
  try {
    store.insert(makeRecord({ id: 'toggle-test', enabled: false }));
    store.setEnabled('skill', 'toggle-test', true);
    let got = store.get('skill', 'toggle-test');
    assert.equal(got?.enabled, true);
    store.setEnabled('skill', 'toggle-test', false);
    got = store.get('skill', 'toggle-test');
    assert.equal(got?.enabled, false);
  } finally {
    store.close();
  }
});

test('capability-store: remove', () => {
  const store = freshStore();
  try {
    store.insert(makeRecord({ id: 'remove-test' }));
    assert.ok(store.get('skill', 'remove-test'), 'should exist before remove');
    const removed = store.remove('skill', 'remove-test');
    assert.equal(removed, true, 'remove should return true when it deletes a row');
    assert.equal(store.get('skill', 'remove-test'), undefined, 'should be gone after remove');
  } finally {
    store.close();
  }
});

test('capability-store: config JSON is parsed correctly', () => {
  const store = freshStore();
  try {
    store.insert(makeRecord({
      id: 'config-test',
      config: { mcpUrl: 'http://localhost:8080', mcpTransport: 'sse' },
    }));
    const got = store.get('skill', 'config-test');
    assert.deepEqual(got?.config, { mcpUrl: 'http://localhost:8080', mcpTransport: 'sse' });
  } finally {
    store.close();
  }
});

// Setup and teardown
test.before(() => {
  tempDir = resolve(process.cwd(), '.tmp', 'test-capability-store');
  mkdirSync(tempDir, { recursive: true });
  tempDbPath = resolve(tempDir, 'capabilities-test.sqlite');
});

test.after(() => {
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});