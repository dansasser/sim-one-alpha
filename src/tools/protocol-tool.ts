import { Type, defineTool } from '@flue/runtime';
import { SqliteProtocolProviderPlaceholder } from '../protocols/sqlite-protocol-provider-placeholder.js';

const provider = new SqliteProtocolProviderPlaceholder('protocols.sqlite');

export const loadProtocolsTool = defineTool({
  name: 'load_protocols',
  description: 'Load applicable protocol directives from the protocol store placeholder.',
  parameters: Type.Object({
    eventId: Type.String(),
    connector: Type.Optional(Type.String()),
    messageKind: Type.Optional(Type.String()),
  }),
  execute: async ({ eventId, connector, messageKind }) => {
    const bundle = await provider.loadApplicable({
      id: String(eventId),
      connector: connector === 'telegram' ? 'telegram' : 'unknown',
      kind: messageKind === 'command' ? 'command' : 'chat.message',
      text: '',
      receivedAt: new Date().toISOString(),
      actor: { id: 'tool-call' },
      conversation: { id: 'tool-call' },
    });

    return JSON.stringify(bundle);
  },
});

