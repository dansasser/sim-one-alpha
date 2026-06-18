import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeWebApiMessage } from '../../connectors/web-api.js';
import {
  getStructuredMemoryRuntime,
  resetStructuredMemoryRuntime,
} from '../../memory/structured-memory-runtime.js';
import { rememberMemoryLookupEvent } from '../../tools/memory-tool.js';
import type { NormalizedMessageEvent } from '../../types/index.js';

export interface MemoryTestSetup {
  event: NormalizedMessageEvent;
  cleanup: () => void;
}

/**
 * Initialize the structured-memory runtime with a temp SQLite DB (in-memory
 * engine under GOROMBO_TEST_MODE) and register a trusted normalized message
 * event for the orchestrator memory tools. Returns the event + a cleanup fn.
 */
export function setupMemoryToolTest(input: {
  actorId?: string;
  conversationId?: string;
  projectId?: string;
} = {}): MemoryTestSetup {
  const dir = mkdtempSync(join(tmpdir(), 'gorombo-memtools-'));
  resetStructuredMemoryRuntime();
  void getStructuredMemoryRuntime({
    version: 1,
    models: { primary: 'x' },
    memory: { backend: 'memory', sqlitePath: join(dir, 'structured.sqlite') },
  } as never);

  const event = normalizeWebApiMessage({
    text: 'memory tool test',
    actorId: input.actorId ?? 'mem-actor',
    conversationId: input.conversationId ?? 'mem-conv',
    ...(input.projectId ? { projectId: input.projectId } : {}),
  });
  rememberMemoryLookupEvent(event);

  return {
    event,
    cleanup: () => {
      resetStructuredMemoryRuntime();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
