import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultRegistries } from '../registries/default-registries.js';
import { InMemoryRegistry } from '../registries/generic-registry.js';
import type { ToolDefinition } from '../types/index.js';

test('registry stores and retrieves enabled definitions', () => {
  const registry = new InMemoryRegistry<ToolDefinition>();

  registry.register({
    id: 'user.echo',
    name: 'Echo',
    description: 'Echo test tool.',
    scope: 'user',
    enabled: true,
    kind: 'placeholder',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
  });

  assert.equal(registry.require('user.echo').name, 'Echo');
  assert.equal(registry.list({ enabledOnly: true }).length, 1);
  assert.equal(registry.list({ scope: 'base' }).length, 0);
});

test('registry rejects duplicate ids', () => {
  const registry = new InMemoryRegistry<ToolDefinition>();
  const definition: ToolDefinition = {
    id: 'duplicate',
    name: 'Duplicate',
    description: 'Duplicate test tool.',
    scope: 'base',
    enabled: true,
    kind: 'placeholder',
    inputSchema: {},
    outputSchema: {},
  };

  registry.register(definition);
  assert.throws(() => registry.register(definition), /already exists/);
});

test('default registries expose Phase 1 base capabilities', () => {
  const registries = createDefaultRegistries();

  assert.ok(registries.tools.require('protocol.load'));
  assert.ok(registries.tools.require('rag.retrieve'));
  assert.ok(registries.skills.require('chat.route-basic'));
  assert.ok(registries.agents.require('main-orchestrator'));
  assert.ok(registries.agents.require('coding-worker'));
  assert.ok(registries.protocols.require('global.protocols-first'));
});
