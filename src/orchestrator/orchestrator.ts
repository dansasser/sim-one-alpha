import type { MemoryRouter } from '../memory/memory-router.js';
import type { ProtocolProvider } from '../protocols/protocol-provider.js';
import { SqliteProtocolProviderPlaceholder } from '../protocols/sqlite-protocol-provider-placeholder.js';
import { createDefaultRegistries, type DefaultRegistries } from '../registries/default-registries.js';
import { DocumentIndexProviderPlaceholder, createDefaultWebSearchProvider, type RagProvider } from '../rag/providers.js';
import { RagRouter } from '../rag/rag-router.js';
import { DatabaseMemoryProviderPlaceholder } from '../memory/memory-provider.js';
import type { NormalizedMessageEvent, OrchestratorResponse } from '../types/index.js';
import { MemoryRouter as DefaultMemoryRouter } from '../memory/memory-router.js';

export interface OrchestratorDependencies {
  protocols: ProtocolProvider;
  rag: RagRouter;
  registries: DefaultRegistries;
}

export interface DefaultOrchestratorOptions {
  env?: Record<string, unknown>;
  webSearchProvider?: RagProvider;
}

export class Orchestrator {
  constructor(private readonly dependencies: OrchestratorDependencies) {}

  async handle(event: NormalizedMessageEvent): Promise<OrchestratorResponse> {
    const protocolBundle = await this.dependencies.protocols.loadApplicable(event);
    const retrievedContext = await this.dependencies.rag.retrieve({
      eventId: event.id,
      text: event.text,
      actorId: event.actor.id,
      conversationId: event.conversation.id,
    });

    const text = event.text.trim()
      ? `Received your ${event.connector} message and routed it through the Phase 1 orchestrator foundation.`
      : 'Received an empty message event and routed it through the Phase 1 orchestrator foundation.';

    return {
      id: `response:${event.id}`,
      eventId: event.id,
      status: 'ok',
      routedTo: 'main-orchestrator',
      text,
      protocolBundle,
      retrievedContext,
      toolCalls: ['protocol.load', 'rag.retrieve'],
      diagnostics: {
        protocolCount: protocolBundle.protocols.length,
        retrievedContextCount: retrievedContext.contexts.length,
        registryCounts: {
          tools: this.dependencies.registries.tools.list({ enabledOnly: true }).length,
          skills: this.dependencies.registries.skills.list({ enabledOnly: true }).length,
          agents: this.dependencies.registries.agents.list({ enabledOnly: true }).length,
        },
      },
    };
  }
}

export function createDefaultOrchestrator(options: DefaultOrchestratorOptions = {}): Orchestrator {
  const env = options.env ?? process.env;
  const memoryRouter: MemoryRouter = new DefaultMemoryRouter(
    new DatabaseMemoryProviderPlaceholder('memory-db-placeholder'),
  );

  return new Orchestrator({
    protocols: new SqliteProtocolProviderPlaceholder('protocols.sqlite'),
    rag: new RagRouter(memoryRouter, [
      options.webSearchProvider ?? createDefaultWebSearchProvider(env),
      new DocumentIndexProviderPlaceholder(),
    ]),
    registries: createDefaultRegistries(),
  });
}
