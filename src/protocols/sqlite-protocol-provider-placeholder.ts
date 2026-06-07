import type { NormalizedMessageEvent, ProtocolBundle, ProtocolDefinition } from '../types/index.js';
import { baseProtocolSeeds, type ProtocolProvider } from './protocol-provider.js';
import { protocolSchemaSql } from './schema.js';

export class SqliteProtocolProviderPlaceholder implements ProtocolProvider {
  readonly schema = protocolSchemaSql;

  constructor(
    readonly dbPath: string,
    private readonly protocols: ProtocolDefinition[] = baseProtocolSeeds,
  ) {}

  async loadApplicable(event: NormalizedMessageEvent): Promise<ProtocolBundle> {
    const protocols = this.protocols
      .filter((protocol) => protocol.enabled)
      .filter((protocol) => protocolApplies(protocol, event))
      .sort((left, right) => right.priority - left.priority);

    return {
      eventId: event.id,
      protocols,
      loadedAt: new Date().toISOString(),
    };
  }

  listSeedProtocols(): ProtocolDefinition[] {
    return [...this.protocols];
  }
}

function protocolApplies(protocol: ProtocolDefinition, event: NormalizedMessageEvent): boolean {
  const selector = protocol.appliesTo;

  return (
    matches(selector.connector, event.connector) &&
    matches(selector.messageKind, event.kind) &&
    matches(selector.userId, event.actor.id) &&
    matches(selector.clientId, event.context?.clientId) &&
    matches(selector.projectId, event.context?.projectId) &&
    matches(selector.workflow, event.context?.workflow) &&
    matches(selector.task, event.context?.task)
  );
}

function matches(expected: string | undefined, actual: string | undefined): boolean {
  return expected === undefined || expected === actual;
}

