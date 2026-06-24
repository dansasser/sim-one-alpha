#!/usr/bin/env node
/**
 * Memory Helper smoke test.
 *
 * Exercises the structured-memory subsystem end-to-end (deterministic, no live
 * model required): registers a trusted event, drives the orchestrator memory
 * tools to create a checklist + nested item + todo + session note, retrieves
 * them via `retrieve_memory` (structured-memory provider), then simulates a
 * process restart by resetting the runtime singleton and re-querying the same
 * SQLite store to confirm durability.
 *
 * Set GOROMBO_SMOKE_REAL_MODEL=1 to additionally drive the orchestrator via
 * the Flue CLI with a natural-language prompt (requires a configured model).
 *
 * Prereq: `pnpm run wasm:build` must have produced the WASM artifact. The
 * script compiles TS to .tmp/tsc and imports from there.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const TSC_ROOT = join(process.cwd(), '.tmp', 'tsc');

function compileTs() {
  const r = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], {
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    throw new Error(`tsc compile failed (status ${r.status})`);
  }
  // Copy the WASM artifact + runtime config into .tmp/tsc so imports resolve.
  // Fail fast if either copy step fails; otherwise we would proceed with stale
  // artifacts and produce misleading downstream errors.
  const cfg = spawnSync(process.execPath, ['scripts/copy-runtime-config.mjs', '--tsc'], { stdio: 'inherit' });
  if (cfg.status !== 0) {
    throw new Error(`copy-runtime-config.mjs failed (status ${cfg.status})`);
  }
  const wasm = spawnSync(process.execPath, ['scripts/copy-wasm-artifact.mjs', '--tsc'], { stdio: 'inherit' });
  if (wasm.status !== 0) {
    throw new Error(`copy-wasm-artifact.mjs failed (status ${wasm.status})`);
  }
}

async function loadModules() {
  const base = `file://${TSC_ROOT}`;
  return {
    runtime: await import(`${base}/memory/structured-memory-runtime.js`),
    tools: await import(`${base}/tools/index.js`),
    memoryTool: await import(`${base}/tools/memory-tool.js`),
    cwMemory: await import(`${base}/workers/coding-worker/tools/coding-task-memory-tools.js`),
    cwApproval: await import(`${base}/workers/coding-worker/approvals/approval-service.js`),
    taskRunStore: await import(`${base}/workers/coding-worker/session/task-run-store.js`),
  };
}

function assert(cond, msg) {
  if (!cond) throw new Error(`smoke assertion failed: ${msg}`);
}


import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

async function realModelSmoke() {
  if (!existsSync('.env')) {
    throw new Error('real-model smoke requires a .env with model + API creds');
  }
  if (!existsSync(join(process.cwd(), '.gorombo', 'sim-one-alpha', 'server.mjs'))) {
    throw new Error('real-model smoke requires `pnpm run build` first (.gorombo/sim-one-alpha/server.mjs)');
  }
  const port = Number(process.env.GOROMBO_SMOKE_PORT || 3997);
  const apiSecret = process.env.GOROMBO_SMOKE_API_SECRET || 'smoke-secret';
  const sqlitePath = process.env.GOROMBO_MEMORY_SQLITE_PATH || join(tmpdir(), `real-model-smoke-${Date.now()}.sqlite`);
  const actorId = 'rm-actor';
  const conversationId = 'rm-conv';

  const env = {
    ...parseEnvFile('.env'),
    PORT: String(port),
    API_SECRET: apiSecret,
    // Test mode lets the server boot without real Telegram creds; the
    // GOROMBO_MEMORY_WASM_MODULE_PATH override forces the production WASM
    // engine + SQLite (not the in-memory test fallback) so this is a real
    // end-to-end run.
    GOROMBO_TEST_MODE: '1',
    GOROMBO_MEMORY_WASM_MODULE_PATH: join(process.cwd(), 'crates', 'gorombo-memory', 'pkg', 'gorombo_memory.js'),
    GOROMBO_MEMORY_SQLITE_PATH: sqlitePath,
    PATH: process.env.PATH,
  };

  const child = spawn(process.execPath, ['--env-file=.env', '.gorombo/sim-one-alpha/server.mjs'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const logPath = join(process.cwd(), '.tmp', 'real-model-smoke-server.log');
  try {
    await waitForHealth(`http://127.0.0.1:${port}`);
    console.log('[smoke:real-model] server healthy; posting chat event');

    const response = await fetch(`http://127.0.0.1:${port}/api/chat/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-secret': apiSecret },
      body: JSON.stringify({
        text: 'Use the memory tools to durably store for this conversation: (1) create_checklist titled Memory Smoke slug memory-smoke with items Setup and Run; (2) add_checklist_item nested under Setup called Nested; (3) create_todo titled Finish smoke priority high; (4) store_session_note titled Smoke decision content real-model smoke verified. Then reply with a one-line summary.',
        actorId,
        conversationId,
        session: 'rm-session',
      }),
    });
    const body = await response.json();
    console.log('[smoke:real-model] agent responded:', String(body?.result?.text ?? '').slice(0, 160));
    if (!response.ok) {
      throw new Error(`chat event returned ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
    }

    // Verify the records were durably persisted by the real model-driven tool calls.
    const db = new DatabaseSync(sqlitePath);
    const rows = db.prepare('SELECT kind, title, slug, status, record_json FROM structured_memory_records ORDER BY kind').all();
    db.close();
    const checklist = rows.find((r) => r.kind === 'checklist');
    const todo = rows.find((r) => r.kind === 'todo');
    const note = rows.find((r) => r.kind === 'session_note');
    assert(checklist && checklist.title === 'Memory Smoke', 'real model created the checklist');
    const items = JSON.parse(checklist.record_json).items;
    assert(items.some((i) => i.title === 'Setup') && items.some((i) => i.title === 'Run'), 'checklist has Setup + Run');
    assert(items.some((i) => i.title === 'Nested' && i.parentId), 'nested item added under a parent');
    assert(todo && todo.title === 'Finish smoke' && JSON.parse(todo.record_json).priority === 'high', 'high-priority todo created');
    assert(note && note.title === 'Smoke decision' && JSON.parse(note.record_json).content.includes('real-model smoke verified'), 'session note stored');
    console.log(`[smoke:real-model] verified ${rows.length} durable records (checklist+todo+note) created by the live model`);
    console.log('[smoke:real-model] PASS: real-model orchestrator smoke verified end-to-end.');
  } finally {
    try { process.kill(-child.pid); } catch { try { child.kill(); } catch {} }
  }
}

function parseEnvFile(path) {
  const values = {};
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, 'utf-8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const sep = t.indexOf('=');
    if (sep === -1) continue;
    values[t.slice(0, sep)] = t.slice(sep + 1).replace(/^[\'"]|[\'"]$/g, '');
  }
  return values;
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${baseUrl}/health`); if (r.ok) return; } catch (e) { lastError = e; }
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error(`server did not become healthy: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function main() {
  if (process.env.GOROMBO_SMOKE_REAL_MODEL === '1') {
    await realModelSmoke();
    return;
  }

  if (!existsSync(join('crates', 'gorombo-memory', 'pkg', 'gorombo_memory_bg.wasm'))) {
    throw new Error('WASM artifact missing. Run `pnpm run wasm:build` first.');
  }
  compileTs();

  const smokeDir = mkdtempSync(join(tmpdir(), 'gorombo-smoke-'));
  const sqlitePath = join(smokeDir, 'structured.sqlite');
  // Point the structured-memory runtime at a temp SQLite via env override.
  process.env.GOROMBO_MEMORY_SQLITE_PATH = sqlitePath;
  // Use the dev WASM artifact path.
  process.env.GOROMBO_MEMORY_WASM_MODULE_PATH = join(process.cwd(), 'crates', 'gorombo-memory', 'pkg', 'gorombo_memory.js');

  const { runtime, tools, memoryTool, cwMemory, cwApproval, taskRunStore } = await loadModules();

  // Register a trusted event via the session database.
  const sessionId = `smoke-${Date.now()}`;
  const event = {
    id: `evt-smoke-${Date.now()}`,
    connector: 'web-api',
    kind: 'chat.message',
    text: 'Create a checklist called "Phase 0 prep" with three items, add a todo "Run smoke test", and store a note about the architectural decision.',
    receivedAt: new Date().toISOString(),
    actor: { id: 'smoke-actor', displayName: 'Smoke' },
    conversation: { id: 'smoke-conv' },
    context: { projectId: 'smoke-proj' },
  };
  memoryTool.rememberMemoryLookupEvent(event);
  memoryTool.resetMemoryRouterCache();

  // Drive the orchestrator memory tools.
  const checklistRes = JSON.parse(
    await tools.createChecklistTool.execute({
      eventId: event.id,
      title: 'Phase 0 prep',
      slug: 'phase-0-prep',
      items: [{ title: 'Schemas' }, { title: 'Engine' }, { title: 'Tools' }],
    }),
  );
  const checklistId = checklistRes.checklist.id;
  assert(checklistId, 'create_checklist returned an id');
  console.log(`[smoke] created checklist ${checklistId} with ${checklistRes.checklist.items.length} items`);

  await tools.addChecklistItemTool.execute({
    eventId: event.id,
    checklistId,
    parentId: checklistRes.checklist.items[0].id,
    title: 'Nested schema detail',
  });

  const todoRes = JSON.parse(
    await tools.createTodoTool.execute({ eventId: event.id, title: 'Run smoke test', priority: 'high' }),
  );
  assert(todoRes.todo.id, 'create_todo returned an id');
  console.log(`[smoke] created todo ${todoRes.todo.id}`);

  const noteRes = JSON.parse(
    await tools.storeSessionNoteTool.execute({
      eventId: event.id,
      title: 'Architectural decision',
      content: 'Flat store + tree render; Rust owns compute, TS owns boundaries.',
      importance: 'high',
    }),
  );
  assert(noteRes.note.id, 'store_session_note returned an id');
  console.log(`[smoke] stored note ${noteRes.note.id}`);

  // Retrieve via retrieve_memory (structured-memory provider).
  const retrieved = JSON.parse(await memoryTool.retrieveMemoryTool.execute({ eventId: event.id, text: 'phase smoke architectural' }));
  const structured = (retrieved.contexts ?? []).filter((c) => c.provider === 'structured-memory');
  assert(structured.length > 0, 'retrieve_memory returned structured-memory contexts');
  const kinds = new Set(structured.map((c) => c.metadata?.kind));
  assert(kinds.has('checklist') && kinds.has('todo') && kinds.has('session_note'), `retrieve_memory returned all three kinds: ${[...kinds].join(',')}`);
  console.log(`[smoke] retrieve_memory returned ${structured.length} structured-memory contexts (${[...kinds].join(', ')})`);

  // Simulate a process restart: reset the runtime singleton and reload from the same SQLite.
  runtime.resetStructuredMemoryRuntime();
  const reloaded = await runtime.getStructuredMemoryRuntime();
  const afterRestart = await reloaded.engine.query({ scope: { projectId: 'smoke-proj', conversationId: 'smoke-conv', actorId: 'smoke-actor' }, includeArchived: true });
  assert(afterRestart.some((r) => r.kind === 'checklist' && r.id === checklistId), 'checklist survived restart');
  assert(afterRestart.some((r) => r.kind === 'todo' && r.title === 'Run smoke test'), 'todo survived restart');
  assert(afterRestart.some((r) => r.kind === 'session_note' && r.title === 'Architectural decision'), 'note survived restart');
  console.log(`[smoke] durability OK: ${afterRestart.length} records survived a simulated restart`);

  // --- Coding worker path (coding_task_* tools, project-scoped + audit-only) ---
  const cwApprovalService = cwApproval.createInMemoryCodingApprovalService();
  const cwTaskRunStore = new taskRunStore.InMemoryCodingTaskRunStore();
  const cwTools = cwMemory.createCodingTaskMemoryTools({
    engineLoader: () => Promise.resolve(reloaded.engine),
    projectId: 'smoke-cw-proj',
    approvalService: cwApprovalService,
    taskRunStore: cwTaskRunStore,
  });
  function getCw(name) { const t = cwTools.find((x) => x.name === name); if (!t) throw new Error(`coding tool ${name} missing`); return t; }

  const cwChecklist = JSON.parse(
    await getCw('coding_task_create_checklist').execute({ taskId: 'cw-task-1', title: 'CW phase', slug: 'cw-phase' }),
  );
  assert(cwChecklist.checklist.scope.projectId === 'smoke-cw-proj', 'coding_task_create_checklist injects projectId');
  console.log(`[smoke] coding-worker created project-scoped checklist ${cwChecklist.checklist.id}`);

  const cwTodo = JSON.parse(
    await getCw('coding_task_add_todo').execute({ taskId: 'cw-task-1', title: 'Implement memory helper' }),
  );
  assert(cwTodo.todo.scope.projectId === 'smoke-cw-proj', 'coding_task_add_todo injects projectId');
  await getCw('coding_task_complete_todo').execute({ taskId: 'cw-task-1', id: cwTodo.todo.id });

  const cwNote = JSON.parse(
    await getCw('coding_task_store_note').execute({ taskId: 'cw-task-1', title: 'CW decision', content: 'audit-only writes, projectId injected' }),
  );
  assert(cwNote.note.scope.projectId === 'smoke-cw-proj', 'coding_task_store_note injects projectId');

  // Plan -> checklist handoff: seed a task run and hand it off.
  await cwTaskRunStore.upsert({
    taskId: 'cw-task-1',
    status: 'completed',
    sessionPlan: { harness: 'coding-worker', session: 'cw-task-1' },
    plan: [
      { id: 'p1', description: 'Scaffold', owner: 'implementer', status: 'completed' },
      { id: 'p2', description: 'Tests', owner: 'test-debug', status: 'completed' },
    ],
    events: [],
    verificationEvidence: [],
    createdAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
  });
  const handoff = JSON.parse(
    await getCw('coding_task_handoff_plan_to_checklist').execute({ taskId: 'cw-task-1', sourceTaskId: 'cw-task-1' }),
  );
  assert(handoff.checklist.title === 'Handoff: cw-task-1', 'handoff checklist titled from source task');
  assert(handoff.checklist.items.length === 2, 'handoff copies plan items');
  console.log(`[smoke] coding-worker handoff checklist ${handoff.checklist.id} (${handoff.checklist.items.length} items)`);

  // Coding-worker search returns the project-scoped records.
  const cwSearch = JSON.parse(
    await getCw('coding_task_search_memory').execute({ taskId: 'cw-task-1', text: 'cw' }),
  );
  assert(cwSearch.contexts.length > 0, 'coding_task_search_memory returns contexts');
  assert(cwSearch.contexts.every((c) => c.provider === 'structured-memory'), 'coding search returns structured-memory contexts');
  console.log(`[smoke] coding-worker search returned ${cwSearch.contexts.length} contexts`);

  const auditRecords = await cwApprovalService.listRecords('cw-task-1');
  const memoryWrite = auditRecords.find((r) => r.request.actionType === 'memory.write');
  assert(memoryWrite, 'coding-worker recorded a memory.write audit event');
  assert(memoryWrite.status === 'approved', 'memory.write audit is approved (audit-only, not pending)');
  console.log(`[smoke] coding-worker audit OK: memory.write event approved (not blocking), ${auditRecords.length} audit records`);

  rmSync(smokeDir, { recursive: true, force: true });
  console.log('[smoke] PASS: Memory Helper end-to-end + durability verified (orchestrator + coding worker).');
}

main().catch((error) => {
  console.error('[smoke] FAIL:', error instanceof Error ? error.message : String(error));
  if (error instanceof Error && error.stack) console.error(error.stack);
  process.exit(1);
});
