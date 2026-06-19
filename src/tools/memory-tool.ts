import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { goromboPersistenceRuntime } from '../db.js';
import { SessionMemoryProvider } from '../memory/memory-provider.js';
import { MemoryRouter } from '../memory/memory-router.js';
import { getStructuredMemoryRuntime, resetStructuredMemoryRuntime } from '../memory/structured-memory-runtime.js';
import type { MemoryProvider } from '../memory/memory-provider.js';
import type { RagProviderKind, RetrievedContext } from '../types/index.js';
import type { NormalizedMessageEvent } from '../types/index.js';

/**
 * Lazily build the multi-provider memory router. The structured-memory
 * provider loads the WASM engine asynchronously, so the router is constructed
 * on first `retrieve_memory` call rather than at module load.
 */
let routerPromise: Promise<MemoryRouter> | undefined;

function getMemoryRouter(): Promise<MemoryRouter> {
  if (!routerPromise) {
    routerPromise = buildMemoryRouter();
  }
  return routerPromise;
}

async function buildMemoryRouter(): Promise<MemoryRouter> {
  const providers = new Map<RagProviderKind, MemoryProvider>();
  providers.set(
    'memory',
    new SessionMemoryProvider({
      vectorStore: goromboPersistenceRuntime.vectorStore,
      embeddingClient: goromboPersistenceRuntime.embeddingClient,
    }),
  );
  try {
    const runtime = await getStructuredMemoryRuntime();
    providers.set('structured-memory', runtime.provider);
  } catch (error) {
    console.error(
      '[WARN] structured-memory provider unavailable; will retry on next call:',
      error instanceof Error ? error.message : String(error),
    );
    // Invalidate the cached (failed) runtime + router so the next retrieve_memory
    // call retries initialization instead of permanently serving a degraded router.
    resetStructuredMemoryRuntime();
    routerPromise = undefined;
  }
  return new MemoryRouter(providers);
}

export const retrieveMemoryTool = defineTool({
  name: 'retrieve_memory',
  description: 'Retrieve relevant context from persisted session memory and structured memory (checklists, todos, session notes).',
  parameters: v.object({
    eventId: v.string(),
    text: v.string(),
  }),
  execute: async ({ eventId, text }) => {
    const event = getTrustedMemoryLookupEvent(eventId);
    const actorId = requireScopeValue(event.actor.id, 'actorId');
    const conversationId = requireScopeValue(event.conversation.id, 'conversationId');
    const router = await getMemoryRouter();
    const contexts = await router.retrieve({
      eventId: String(eventId),
      text: String(text),
      actorId,
      conversationId,
      threadId: event.conversation.threadId,
      projectId: event.context?.projectId,
      providers: ['memory', 'structured-memory'],
    });

    return JSON.stringify({ contexts: contexts as RetrievedContext[] });
  },
});

export function rememberMemoryLookupEvent(event: NormalizedMessageEvent): void {
  goromboPersistenceRuntime.sessionDatabase.recordNormalizedMessageEvent({
    event: {
      id: event.id,
      connector: event.connector,
      kind: event.kind,
      text: event.text,
      receivedAt: event.receivedAt,
      actor: { ...event.actor },
      conversation: { ...event.conversation },
      ...(event.context ? { context: { ...event.context } } : {}),
    },
  });
}

/** Test helper: reset the lazily-built router (e.g. when re-registering events). */
export function resetMemoryRouterCache(): void {
  routerPromise = undefined;
}

function getTrustedMemoryLookupEvent(eventId: unknown): NormalizedMessageEvent {
  const event = goromboPersistenceRuntime.sessionDatabase.getNormalizedMessageEvent(String(eventId));
  if (!event) {
    throw new Error('retrieve_memory requires a trusted eventId persisted by chat ingress.');
  }
  return event;
}

function requireScopeValue(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`retrieve_memory cannot run without trusted ${fieldName}.`);
  }
  return value.trim();
}
