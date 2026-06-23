/**
 * Scope-enforcement test for coding-worker schedule tools (plan §9, AGENTS.md
 * project boundary). Verifies that a coding-worker on project A cannot
 * read/mutate schedules owned by project B, and that list is scoped to the
 * current project.
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test from 'node:test';
import type { FlueEvent } from '@flue/runtime';

import { resolveScheduleConfig } from '../schedules/schedule-config.js';
import type { DispatchScheduleArgs, ScheduleDispatchResult } from '../schedules/schedule-dispatch.js';
import { __setScheduleManagerForTesting } from '../schedules/boot.js';
import { ScheduleManager } from '../schedules/schedule-manager.js';
import { ScheduleStore } from '../schedules/schedule-store.js';
import { createCodingScheduleTools } from '../workers/coding-worker/tools/coding-schedule-tools.js';
import type { ToolDefinition } from '@flue/runtime';

function tempDbPath(): string {
  return `/tmp/sim-one-coding-sched-${Date.now()}-${Math.floor(Math.random() * 1e6)}.sqlite`;
}

function makeManager(path: string): ScheduleManager {
  const store = new ScheduleStore(path);
  const fakeObserve = (): (() => void) => () => {};
  const fakeDispatch = async (args: DispatchScheduleArgs): Promise<ScheduleDispatchResult> => ({
    dispatchId: 'd-' + args.instanceId,
    acceptedAt: new Date().toISOString(),
    instanceId: args.instanceId,
  });
  const config = resolveScheduleConfig({}, {});
  const manager = new ScheduleManager({
    store,
    config,
    dispatch: fakeDispatch,
    observeFn: fakeObserve as never,
    observeTimeoutMs: 1000,
  });
  manager.start();
  return manager;
}

function toolByName(tools: ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((t) => t.name === name);
  assert.ok(found, `tool ${name} present`);
  return found!;
}

test('coding schedule tools enforce project scope (cross-project denied, list filtered)', async () => {
  const path = tempDbPath();
  const manager = makeManager(path);
  __setScheduleManagerForTesting(manager);
  try {
    // Seed a schedule owned by a DIFFERENT project (projB).
    manager.store.upsert({
      slug: 'b-sched',
      kind: 'cron',
      schedule: '0 9 * * *',
      prompt: 'x',
      ownerScope: 'projB',
    });

    // Tools scoped to projA.
    const tools = createCodingScheduleTools({ projectId: 'projA' });

    // get on projB's schedule -> scope error
    const getResult = toolByName(tools, 'coding_schedule_get');
    const getOut = JSON.parse(await getResult.execute({ slug: 'b-sched' }) as string) as { error?: string };
    assert.match(getOut.error ?? '', /does not belong to this project scope/, 'get denied cross-project');

    // delete on projB's schedule -> scope error, schedule still present
    const deleteTool = toolByName(tools, 'coding_schedule_delete');
    const delOut = JSON.parse(await deleteTool.execute({ slug: 'b-sched' }) as string) as { error?: string; deleted?: boolean };
    assert.match(delOut.error ?? '', /does not belong to this project scope/, 'delete denied cross-project');
    assert.ok(manager.store.getBySlug('b-sched'), 'projB schedule not deleted by projA');

    // list (projA) -> does not include b-sched
    const listTool = toolByName(tools, 'coding_schedule_list');
    const listOut = JSON.parse(await listTool.execute({}) as string) as { schedules: { slug: string }[] };
    assert.equal(listOut.schedules.length, 0, 'projA list excludes projB schedule');

    // create a projA schedule via the tool -> list now includes it
    const createTool = toolByName(tools, 'coding_schedule_create');
    await createTool.execute({ slug: 'a-sched', kind: 'cron', schedule: '0 9 * * *', prompt: 'a' }) as string;
    const listAfter = JSON.parse(await listTool.execute({}) as string) as { schedules: { slug: string }[] };
    assert.deepEqual(
      listAfter.schedules.map((s) => s.slug),
      ['a-sched'],
      'projA list includes only projA schedule',
    );
    assert.equal(manager.store.getBySlug('a-sched')?.ownerScope, 'projA', 'created schedule owned by projA');

    // delete own (projA) schedule -> succeeds
    const delOwn = JSON.parse(await deleteTool.execute({ slug: 'a-sched' }) as string) as { deleted?: boolean };
    assert.equal(delOwn.deleted, true, 'projA can delete its own schedule');
    assert.equal(manager.store.getBySlug('a-sched'), null, 'a-sched gone');
  } finally {
    manager.stop();
    __setScheduleManagerForTesting(null);
    rmSync(path, { force: true });
  }
});

test('coding schedule tools fail closed when no project scope is injected', async () => {
  const path = tempDbPath();
  const manager = makeManager(path);
  __setScheduleManagerForTesting(manager);
  try {
    const tools = createCodingScheduleTools({ projectId: undefined });
    const listTool = toolByName(tools, 'coding_schedule_list');
    await assert.rejects(
      () => listTool.execute({}),
      /trusted project scope/,
      'no projectId -> fail closed',
    );
  } finally {
    manager.stop();
    __setScheduleManagerForTesting(null);
    rmSync(path, { force: true });
  }
});