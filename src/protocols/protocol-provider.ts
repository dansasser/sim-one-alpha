import type { NormalizedMessageEvent, ProtocolBundle, ProtocolDefinition } from '../types/index.js';

export interface ProtocolProvider {
  loadApplicable(event: NormalizedMessageEvent): Promise<ProtocolBundle>;
  listSeedProtocols(): ProtocolDefinition[];
}

export const baseProtocolSeeds: ProtocolDefinition[] = [
  {
    id: 'global.protocols-first',
    name: 'Protocols First',
    description: 'The orchestrator must load protocols before tool use, delegation, or final response.',
    scope: 'base',
    enabled: true,
    priority: 100,
    appliesTo: {},
    rules: [
      'Load applicable protocols before final reasoning.',
      'Treat protocols as runtime directives, not skills.',
    ],
    source: 'seed',
    tags: ['global', 'orchestration'],
  },
  {
    id: 'chat.basic-safe-response',
    name: 'Basic Safe Chat Response',
    description: 'Default chat routing rule for normalized message events.',
    scope: 'base',
    enabled: true,
    priority: 10,
    appliesTo: {
      messageKind: 'chat.message',
    },
    rules: ['Return a structured response even when all external tools are placeholders.'],
    source: 'seed',
    tags: ['chat'],
  },
];

