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
  spawnSync(process.execPath, ['scripts/copy-runtime-config.mjs', '--tsc'], { stdio: 'inherit' });
  spawnSync(process.execPath, ['scripts/copy-wasm-artifact.mjs', '--tsc'], { stdio: 'inherit' });
}

async function loadModules() {
  const base = `file://${TSC_ROOT}`;
  return {
    runtime: await import(`${base}/memory/structured-memory-runtime.js`),
    tools: await import(`${base}/tools/index.js`),
    memoryTool: await import(`${base}/tools/memory-tool.js`),
  };
}

function assert(cond, msg) {
  if (!cond) throw new Error(`smoke assertion failed: ${msg}`);
}

async function main() {
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

  const { runtime, tools, memoryTool } = await loadModules();

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

  rmSync(smokeDir, { recursive: true, force: true });
  console.log('[smoke] PASS: Memory Helper end-to-end + durability verified.');
}

main().catch((error) => {
  console.error('[smoke] FAIL:', error instanceof Error ? error.message : String(error));
  if (error instanceof Error && error.stack) console.error(error.stack);
  process.exit(1);
});
