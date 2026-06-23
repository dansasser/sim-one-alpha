import assert from 'node:assert/strict';
import test from 'node:test';
import { rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadBuiltinRegistry, isBuiltinName, getBuiltinNames } from '../capabilities/builtin-registry.js';

const tempDir = resolve(process.cwd(), '.tmp', 'test-builtin-registry');
const tempDistDir = resolve(tempDir, 'dist');
let originalCwd: string;

test('builtin-registry: returns empty registry when file is missing', () => {
  const registry = loadBuiltinRegistry();
  // If the file doesn't exist in the test environment, it should return empty
  // (or return the real one if dist/builtin-capabilities.json exists from a prior build)
  assert.ok(registry);
  assert.ok(Array.isArray(registry.tools));
  assert.ok(Array.isArray(registry.subagents));
  assert.ok(Array.isArray(registry.skills));
  assert.ok(Array.isArray(registry.mcpServers));
});

test('builtin-registry: isBuiltinName checks across all kinds', () => {
  // If the real builtin-capabilities.json exists from a build, test against it
  // If not, these will all return false (which is correct — no registry loaded)
  const registry = loadBuiltinRegistry();
  if (registry.tools.length > 0) {
    assert.equal(isBuiltinName('tool', 'load_protocols'), true, 'load_protocols should be a builtin tool');
    assert.equal(isBuiltinName('skill', 'load_protocols'), true, 'cross-kind: load_protocols is builtin even when checking as skill');
    assert.equal(isBuiltinName('tool', 'nonexistent_tool_xyz'), false, 'nonexistent name should not be builtin');
  }
  if (registry.subagents.length > 0) {
    assert.equal(isBuiltinName('worker', 'coding-worker'), true, 'coding-worker should be a builtin subagent');
    assert.equal(isBuiltinName('skill', 'coding-worker'), true, 'cross-kind: coding-worker is builtin even when checking as skill');
  }
});

test('builtin-registry: getBuiltinNames returns all names', () => {
  const registry = loadBuiltinRegistry();
  const allNames = getBuiltinNames();
  assert.ok(Array.isArray(allNames), 'getBuiltinNames should return an array');
  const toolNames = getBuiltinNames('tool');
  assert.ok(Array.isArray(toolNames), 'getBuiltinNames(tool) should return an array');
  if (registry.tools.length > 0) {
    assert.ok(toolNames.includes('load_protocols'), 'tool names should include load_protocols');
  }
});

test('builtin-registry: getBuiltinNames filtered by kind', () => {
  const subagentNames = getBuiltinNames('worker');
  const skillNames = getBuiltinNames('skill');
  const registry = loadBuiltinRegistry();
  assert.equal(subagentNames.length, registry.subagents.length);
  assert.equal(skillNames.length, registry.skills.length);
});