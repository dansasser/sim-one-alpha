import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { baseProtocolSeeds } from '../protocols/protocol-provider.js';
import { SqliteProtocolProvider } from '../protocols/sqlite-protocol-provider.js';
import type { NormalizedMessageEvent } from '../types/index.js';

function createTempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'gorombo-protocols-'));
  return join(dir, 'protocols.sqlite');
}

function cleanup(dbPath: string) {
  rmSync(join(dbPath, '..'), { recursive: true, force: true });
}

function makeEvent(partial: Partial<NormalizedMessageEvent> = {}): NormalizedMessageEvent {
  return {
    id: 'event-1',
    connector: 'web-api',
    kind: 'chat.message',
    text: 'Fix the bug.',
    receivedAt: new Date().toISOString(),
    actor: { id: 'user-1' },
    conversation: { id: 'conversation-1' },
    ...(partial.context ? { context: partial.context } : {}),
    ...partial,
  };
}

test('SqliteProtocolProvider preserves user overrides across seed restarts', async () => {
  const dbPath = createTempDbPath();
  const provider1 = new SqliteProtocolProvider(dbPath);
  try {
    provider1.addProtocol({
      id: 'global.protocols-first',
      name: 'Overridden',
      description: 'User override.',
      rules: ['Override rule.'],
    });
  } finally {
    provider1.close();
  }

  const provider2 = new SqliteProtocolProvider(dbPath);
  try {
    const protocols = provider2.listProtocols();
    assert.equal(protocols.length, baseProtocolSeeds.length);
    const overridden = provider2.getProtocol('global.protocols-first');
    assert.ok(overridden);
    assert.equal(overridden?.scope, 'user');
    assert.equal(overridden?.source, 'sqlite');
    assert.deepEqual(overridden?.rules, ['Override rule.']);
  } finally {
    provider2.close();
    cleanup(dbPath);
  }
});

test('SqliteProtocolProvider seeds base protocols on first use', async () => {
  const dbPath = createTempDbPath();
  const provider = new SqliteProtocolProvider(dbPath);

  try {
    const protocols = provider.listProtocols();
    assert.equal(protocols.length, baseProtocolSeeds.length);
    assert.ok(protocols.some((p) => p.id === 'global.protocols-first'));
    assert.ok(protocols.every((p) => p.source === 'seed' || p.source === 'sqlite'));
  } finally {
    provider.close();
    cleanup(dbPath);
  }
});

test('SqliteProtocolProvider does not duplicate seeds on subsequent runs', async () => {
  const dbPath = createTempDbPath();
  const provider1 = new SqliteProtocolProvider(dbPath);
  provider1.close();

  const provider2 = new SqliteProtocolProvider(dbPath);

  try {
    const protocols = provider2.listProtocols();
    assert.equal(protocols.length, baseProtocolSeeds.length);
  } finally {
    provider2.close();
    cleanup(dbPath);
  }
});

test('SqliteProtocolProvider matches protocols by selector', async () => {
  const dbPath = createTempDbPath();
  const provider = new SqliteProtocolProvider(dbPath);

  try {
    const codingEvent = makeEvent({ context: { workflow: 'coding', task: 'code-change' } });
    const bundle = await provider.loadApplicable(codingEvent);

    assert.equal(bundle.eventId, codingEvent.id);
    assert.ok(bundle.protocols.length > 0);
    assert.ok(bundle.protocols.some((p) => p.id === 'coding.use-coding-worker'));
    assert.ok(bundle.protocols.some((p) => p.id === 'coding.output-report'));
    assert.equal(bundle.protocols[0].priority >= (bundle.protocols.at(-1)?.priority ?? 0), true);
  } finally {
    provider.close();
    cleanup(dbPath);
  }
});

test('SqliteProtocolProvider filters non-matching selectors', async () => {
  const dbPath = createTempDbPath();
  const provider = new SqliteProtocolProvider(dbPath);

  try {
    const chatEvent = makeEvent({ kind: 'chat.message' });
    const bundle = await provider.loadApplicable(chatEvent);

    assert.ok(bundle.protocols.some((p) => p.id === 'chat.basic-safe-response'));
    assert.ok(!bundle.protocols.some((p) => p.id.startsWith('coding.')));
  } finally {
    provider.close();
    cleanup(dbPath);
  }
});

test('SqliteProtocolProvider supports user protocol CRUD', async () => {
  const dbPath = createTempDbPath();
  const provider = new SqliteProtocolProvider(dbPath);

  try {
    const added = provider.addProtocol({
      id: 'user.custom-rule',
      name: 'Custom User Rule',
      description: 'A user-defined rule.',
      priority: 95,
      appliesTo: { workflow: 'coding' },
      rules: ['Always run extra tests.'],
      tags: ['custom'],
    });

    assert.equal(added.scope, 'user');
    assert.equal(added.source, 'sqlite');

    const retrieved = provider.getProtocol('user.custom-rule');
    assert.ok(retrieved);
    assert.deepEqual(retrieved?.rules, ['Always run extra tests.']);

    provider.setEnabled('user.custom-rule', false);
    const disabled = provider.getProtocol('user.custom-rule');
    assert.equal(disabled?.enabled, false);

    const removed = provider.removeProtocol('user.custom-rule');
    assert.equal(removed, true);
    assert.equal(provider.getProtocol('user.custom-rule'), undefined);
  } finally {
    provider.close();
    cleanup(dbPath);
  }
});

test('SqliteProtocolProvider forbids base protocol enable/disable', async () => {
  const dbPath = createTempDbPath();
  const provider = new SqliteProtocolProvider(dbPath);

  try {
    assert.throws(() => provider.setEnabled('global.protocols-first', false), /Cannot enable or disable base/);
    assert.throws(() => provider.setEnabled('global.protocols-first', true), /Cannot enable or disable base/);
  } finally {
    provider.close();
    cleanup(dbPath);
  }
});

test('SqliteProtocolProvider forbids base protocol removal', async () => {
  const dbPath = createTempDbPath();
  const provider = new SqliteProtocolProvider(dbPath);

  try {
    assert.throws(() => provider.removeProtocol('global.protocols-first'), /Cannot remove base/);
  } finally {
    provider.close();
    cleanup(dbPath);
  }
});

test('SqliteProtocolProvider user protocols can override base ids', async () => {
  const dbPath = createTempDbPath();
  const provider = new SqliteProtocolProvider(dbPath);

  try {
    const added = provider.addProtocol({
      id: 'global.protocols-first',
      name: 'Overridden',
      description: 'User override.',
      rules: ['New rule.'],
    });

    assert.equal(added.scope, 'user');
    assert.equal(added.source, 'sqlite');
    assert.deepEqual(added.rules, ['New rule.']);
  } finally {
    provider.close();
    cleanup(dbPath);
  }
});

test('SqliteProtocolProvider backfills missing seed protocols and preserves tags', async () => {
  const dbPath = createTempDbPath();

  const seedOne = baseProtocolSeeds[0];

  // Manually pre-load only one seed row, bypassing the provider's backfill logic.
  const provider1 = new SqliteProtocolProvider(dbPath);
  try {
    provider1.addProtocol({
      id: seedOne.id,
      name: seedOne.name,
      description: seedOne.description,
      priority: seedOne.priority,
      appliesTo: seedOne.appliesTo,
      rules: [...seedOne.rules],
      tags: seedOne.tags ? [...seedOne.tags] : undefined,
    });

    // Override the source/scope to mimic an older seed database row.
    // @ts-expect-error accessing private member for test setup
    provider1.database
      .prepare(`UPDATE protocols SET scope = 'base', source = 'seed' WHERE id = ?`)
      .run(seedOne.id);
  } finally {
    provider1.close();
  }

  // Reopening the provider should backfill the rest of baseProtocolSeeds.
  const provider2 = new SqliteProtocolProvider(dbPath);
  try {
    const protocols = provider2.listProtocols();
    assert.equal(protocols.length, baseProtocolSeeds.length);

    for (const seed of baseProtocolSeeds) {
      const found = protocols.find((p) => p.id === seed.id);
      assert.ok(found, `Expected seed protocol ${seed.id} to be backfilled`);
      assert.deepEqual(found.rules, seed.rules);
      assert.deepEqual(found.tags, seed.tags);
    }
  } finally {
    provider2.close();
    cleanup(dbPath);
  }
});
