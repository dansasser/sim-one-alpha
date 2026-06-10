import type { ProtocolProvider } from '../protocols/protocol-provider.js';
import { SqliteProtocolProviderPlaceholder } from '../protocols/sqlite-protocol-provider-placeholder.js';
import { createDefaultRegistries, type DefaultRegistries } from '../registries/default-registries.js';
import type { NormalizedMessageEvent, OrchestratorResponse, RagResult } from '../types/index.js';

export interface OrchestratorDependencies {
  protocols: ProtocolProvider;
  registries: DefaultRegistries;
}

export interface DefaultOrchestratorOptions {}

export class Orchestrator {
  constructor(private readonly dependencies: OrchestratorDependencies) {}

  async handle(event: NormalizedMessageEvent): Promise<OrchestratorResponse> {
    const protocolBundle = await this.dependencies.protocols.loadApplicable(event);
    const retrievedContext = createNoRetrievalResult(event);

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
      toolCalls: ['protocol.load'],
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
  void options;

  return new Orchestrator({
    protocols: new SqliteProtocolProviderPlaceholder('protocols.sqlite'),
    registries: createDefaultRegistries(),
  });
}

function createNoRetrievalResult(event: NormalizedMessageEvent): RagResult {
  return {
    query: {
      eventId: event.id,
      text: event.text,
      actorId: event.actor.id,
      conversationId: event.conversation.id,
      providers: ['memory'],
      caller: 'orchestrator',
    },
    retrievedAt: new Date().toISOString(),
    contexts: [],
    metadata: {
      retrieval: {
        selectedProviders: ['memory'],
      },
    },
  };
}
