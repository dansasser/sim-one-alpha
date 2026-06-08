import type { FlueContext, WorkflowRouteHandler } from '@flue/runtime';
import { DatabaseMemoryProviderPlaceholder } from '../memory/memory-provider.js';
import { MemoryRouter } from '../memory/memory-router.js';
import { DocumentIndexProviderPlaceholder, createDefaultWebSearchProvider } from '../rag/providers.js';
import { RagRouter } from '../rag/rag-router.js';
import type { RagProviderKind, RagResult } from '../types/index.js';

export const route: WorkflowRouteHandler = async (_c, next) => next();

export interface RetrievalWorkflowPayload {
  eventId: string;
  text: string;
  actorId: string;
  conversationId: string;
  providers?: RagProviderKind[];
  limit?: number;
}

export interface RetrievalWorkflowOptions {
  env?: Record<string, unknown>;
}

export async function run({
  env,
  payload,
}: FlueContext<RetrievalWorkflowPayload>): Promise<RagResult> {
  return retrieveContext(payload, { env });
}

export async function retrieveContext(
  payload: RetrievalWorkflowPayload,
  options: RetrievalWorkflowOptions = {},
): Promise<RagResult> {
  return createRetrievalRouter(options.env ?? process.env).retrieve({
    eventId: String(payload.eventId),
    text: String(payload.text),
    actorId: String(payload.actorId),
    conversationId: String(payload.conversationId),
    providers: payload.providers,
    limit: payload.limit,
  });
}

export function createRetrievalRouter(env: Record<string, unknown> = process.env): RagRouter {
  return new RagRouter(new MemoryRouter(new DatabaseMemoryProviderPlaceholder('memory-db-placeholder')), [
    createDefaultWebSearchProvider(env),
    new DocumentIndexProviderPlaceholder(),
  ]);
}
