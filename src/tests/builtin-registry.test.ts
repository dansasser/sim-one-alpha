import assert from 'node:assert/strict';
import test from 'node:test';
import { rmSync, mkdirSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadBuiltinRegistry, isBuiltinName, getBuiltinNames, resetBuiltinRegistryCache } from '../engine/capabilities/builtin-registry.js';

const fixtureRegistry = {
  tools: ['load_protocols', 'retrieve_memory', 'add_knowledge', 'test_echo'],
  subagents: ['coding-worker', 'researcher'],
  skills: ['chat.route-basic'],
  mcpServers: ['astro-docs'],
};

let tempDir: string;
let originalCwd: string;

function setupFixtureRegistry() {
  const distDir = resolve(tempDir, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    resolve(distDir, 'builtin-capabilities.json'),
    JSON.stringify(fixtureRegistry),
  );
}

test('builtin-registry: isBuiltinName detects builtin tools (cross-kind)', () => {
  resetBuiltinRegistryCache();
  const result = isBuiltinName('skill', 'load_protocols');
  assert.equal(result, true, 'load_protocols is builtin even when checked as skill');
  assert.equal(isBuiltinName('tool', 'load_protocols'), true);
  assert.equal(isBuiltinName('tool', 'nonexistent_xyz'), false);
});

test('builtin-registry: isBuiltinName detects builtin subagents (cross-kind)', () => {
  assert.equal(isBuiltinName('skill', 'coding-worker'), true, 'coding-worker is builtin even when checked as skill');
  assert.equal(isBuiltinName('worker', 'researcher'), true);
  assert.equal(isBuiltinName('skill', 'nonexistent_subagent'), false);
});

test('builtin-registry: isBuiltinName detects builtin mcp servers (cross-kind)', () => {
  assert.equal(isBuiltinName('mcp', 'astro-docs'), true);
  assert.equal(isBuiltinName('skill', 'astro-docs'), true, 'astro-docs is builtin even when checked as skill');
  assert.equal(isBuiltinName('mcp', 'nonexistent_mcp'), false);
});

test('builtin-registry: isBuiltinName detects builtin skills', () => {
  assert.equal(isBuiltinName('skill', 'chat.route-basic'), true);
  assert.equal(isBuiltinName('tool', 'chat.route-basic'), true, 'cross-kind: chat.route-basic is builtin even when checked as tool');
});

test('builtin-registry: getBuiltinNames returns all names when no kind specified', () => {
  const all = getBuiltinNames();
  assert.ok(all.includes('load_protocols'));
  assert.ok(all.includes('coding-worker'));
  assert.ok(all.includes('chat.route-basic'));
  assert.ok(all.includes('astro-docs'));
});

test('builtin-registry: getBuiltinNames filters by kind', () => {
  const tools = getBuiltinNames('tool');
  assert.ok(tools.includes('load_protocols'));
  assert.ok(!tools.includes('coding-worker'), 'coding-worker is a subagent, not a tool');

  const subagents = getBuiltinNames('worker');
  assert.ok(subagents.includes('coding-worker'));
  assert.ok(!subagents.includes('load_protocols'), 'load_protocols is a tool, not a subagent');

  const mcpServers = getBuiltinNames('mcp');
  assert.ok(mcpServers.includes('astro-docs'));
});

test('builtin-registry: throws when registry file is missing', () => {
  resetBuiltinRegistryCache();
  const emptyDir = mkdtempSync(join(tmpdir(), 'builtin-empty-'));
  const prevCwd = process.cwd();
  try {
    process.chdir(emptyDir);
    assert.throws(() => loadBuiltinRegistry(), /not found|corrupted|unreadable/i);
  } finally {
    process.chdir(prevCwd);
    resetBuiltinRegistryCache();
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

test.before(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'builtin-registry-test-'));
  originalCwd = process.cwd();
  setupFixtureRegistry();
  process.chdir(tempDir);
});

test.after(() => {
  resetBuiltinRegistryCache();
  process.chdir(originalCwd);
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});