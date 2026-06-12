import { Type, defineTool } from '@flue/runtime';
import { goromboPersistenceRuntime } from '../db.js';
import { SqliteProtocolProviderPlaceholder } from '../protocols/sqlite-protocol-provider-placeholder.js';
import type { ConnectorKind, MessageKind, NormalizedMessageEvent } from '../types/index.js';

const provider = new SqliteProtocolProviderPlaceholder('protocols.sqlite');
const connectorKinds = new Set<ConnectorKind>(['telegram', 'web-api', 'tui', 'scheduled-job', 'test', 'unknown']);
const messageKinds = new Set<MessageKind>(['chat.message', 'command', 'workflow.event']);

export interface ProtocolToolInput {
  eventId: unknown;
  connector?: unknown;
  messageKind?: unknown;
  actorId?: unknown;
  conversationId?: unknown;
  threadId?: unknown;
  clientId?: unknown;
  projectId?: unknown;
  workflow?: unknown;
  task?: unknown;
}

export const loadProtocolsTool = defineTool({
  name: 'load_protocols',
  description: 'Load applicable protocol directives from the protocol store placeholder.',
  parameters: Type.Object({
    eventId: Type.String(),
    connector: Type.Optional(Type.String()),
    messageKind: Type.Optional(Type.String()),
    actorId: Type.Optional(Type.String()),
    conversationId: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.String()),
    clientId: Type.Optional(Type.String()),
    projectId: Type.Optional(Type.String()),
    workflow: Type.Optional(Type.String()),
    task: Type.Optional(Type.String()),
  }),
  execute: async (input) => {
    const event = createProtocolLookupEvent(input as ProtocolToolInput);
    const bundle = await provider.loadApplicable(event);

    return JSON.stringify(bundle);
  },
});

export function createProtocolLookupEvent(input: ProtocolToolInput): NormalizedMessageEvent {
  const eventId = String(input.eventId);
  const registeredEvent = goromboPersistenceRuntime.sessionDatabase.getNormalizedMessageEvent(eventId);
  const threadId = readNonEmptyString(input.threadId);
  const clientId = readNonEmptyString(input.clientId);
  const projectId = readNonEmptyString(input.projectId);
  const workflow = readNonEmptyString(input.workflow);
  const task = readNonEmptyString(input.task);
  const resolvedClientId = clientId ?? registeredEvent?.context?.clientId;
  const resolvedProjectId = projectId ?? registeredEvent?.context?.projectId;
  const resolvedWorkflow = workflow ?? registeredEvent?.context?.workflow;
  const resolvedTask = task ?? registeredEvent?.context?.task;

  return {
    id: eventId,
    connector: readConnectorKind(input.connector) ?? registeredEvent?.connector ?? 'unknown',
    kind: readMessageKind(input.messageKind) ?? registeredEvent?.kind ?? 'chat.message',
    text: registeredEvent?.text ?? '',
    receivedAt: registeredEvent?.receivedAt ?? new Date().toISOString(),
    actor: { id: readNonEmptyString(input.actorId) ?? registeredEvent?.actor.id ?? 'tool-call' },
    conversation: {
      id: readNonEmptyString(input.conversationId) ?? registeredEvent?.conversation.id ?? 'tool-call',
      ...(threadId ?? registeredEvent?.conversation.threadId
        ? { threadId: threadId ?? registeredEvent?.conversation.threadId }
        : {}),
    },
    ...(resolvedClientId || resolvedProjectId || resolvedWorkflow || resolvedTask
      ? {
          context: {
            ...(resolvedClientId ? { clientId: resolvedClientId } : {}),
            ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
            ...(resolvedWorkflow ? { workflow: resolvedWorkflow } : {}),
            ...(resolvedTask ? { task: resolvedTask } : {}),
          },
        }
      : {}),
  };
}

export function rememberProtocolLookupEvent(event: NormalizedMessageEvent): void {
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

export function forgetProtocolLookupEvent(eventId: string): void {
  goromboPersistenceRuntime.sessionDatabase.deleteNormalizedMessageEvent(eventId);
}

function readConnectorKind(value: unknown): ConnectorKind | undefined {
  return typeof value === 'string' && connectorKinds.has(value as ConnectorKind)
    ? (value as ConnectorKind)
    : undefined;
}

function readMessageKind(value: unknown): MessageKind | undefined {
  return typeof value === 'string' && messageKinds.has(value as MessageKind)
    ? (value as MessageKind)
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
