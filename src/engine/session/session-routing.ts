import { goromboPersistenceRuntime } from '../../db.js';
import type { ConnectorKind, NormalizedMessageEvent } from '../../core/types/index.js';
import type { ChatSessionRecord } from '../../engine/session/session-database.js';

export type ChatSurface = 'web' | 'tui' | 'connector';

export class SessionAccessDeniedError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} is not available for this actor or conversation.`);
    this.name = 'SessionAccessDeniedError';
  }
}

export interface ResolveChatSessionInput {
  event: NormalizedMessageEvent;
  requestedSessionId?: string;
  forceNew?: boolean;
  title?: string;
  displayName?: string;
}

export interface ChatSessionResolution {
  sessionId: string;
  surface: ChatSurface;
  session: ChatSessionRecord;
  created: boolean;
}

export function resolveChatSession(input: ResolveChatSessionInput): ChatSessionResolution {
  const surface = surfaceForEvent(input.event);
  const persistentConnector = connectorUsesPersistentSession(input.event.connector);
  const activeLookup = {
    surface,
    connector: input.event.connector,
    actorId: input.event.actor.id,
    conversationId: input.event.conversation.id,
    threadId: input.event.conversation.threadId,
  };
  const explicitSessionId = cleanSessionId(input.requestedSessionId);
  const existingActiveSessionId = persistentConnector && !input.forceNew
    ? goromboPersistenceRuntime.sessionDatabase.getActiveSession(activeLookup)
    : null;
  const sessionId = explicitSessionId ?? existingActiveSessionId ?? undefined;
  const title = input.title ?? titleFromText(input.event.text);

  if (sessionId && !input.forceNew) {
    const existingSession = goromboPersistenceRuntime.sessionDatabase.getChatSession(sessionId);
    if (existingSession) {
      assertSessionBelongsToEvent(existingSession, input.event);
    }
    const session = goromboPersistenceRuntime.sessionDatabase.ensureChatSession({
      sessionId,
      origin: surface,
      actorId: input.event.actor.id,
      conversationId: input.event.conversation.id,
      threadId: input.event.conversation.threadId,
      title,
      displayName: input.displayName,
    });

    if (persistentConnector) {
      goromboPersistenceRuntime.sessionDatabase.setActiveSession({
        ...activeLookup,
        sessionId,
      });
    }

    return {
      sessionId,
      surface,
      session,
      created: !existingSession,
    };
  }

  const session = goromboPersistenceRuntime.sessionDatabase.createChatSession({
    origin: surface,
    actorId: input.event.actor.id,
    conversationId: input.event.conversation.id,
    threadId: input.event.conversation.threadId,
    title,
    displayName: input.displayName,
  });

  if (persistentConnector) {
    goromboPersistenceRuntime.sessionDatabase.setActiveSession({
      ...activeLookup,
      sessionId: session.sessionId,
    });
  }

  return {
    sessionId: session.sessionId,
    surface,
    session,
    created: true,
  };
}

export function listChatSessions(limit?: number): ChatSessionRecord[] {
  return goromboPersistenceRuntime.sessionDatabase.listChatSessions(limit);
}

export function isGuiSessionManagedConnector(connector: ConnectorKind): boolean {
  return connector === 'web-api';
}

export function connectorUsesPersistentSession(connector: ConnectorKind): boolean {
  return connector === 'telegram';
}

function surfaceForEvent(event: NormalizedMessageEvent): ChatSurface {
  if (isGuiSessionManagedConnector(event.connector)) {
    return 'web';
  }
  if (event.connector === 'tui') {
    return 'tui';
  }
  return 'connector';
}

function cleanSessionId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function assertSessionBelongsToEvent(session: ChatSessionRecord, event: NormalizedMessageEvent): void {
  const storedActorId = cleanScopeValue(session.actorId);
  const storedConversationId = cleanScopeValue(session.conversationId);
  const eventActorId = cleanScopeValue(event.actor.id);
  const eventConversationId = cleanScopeValue(event.conversation.id);

  if (!storedActorId && !storedConversationId) {
    throw new SessionAccessDeniedError(session.sessionId);
  }

  if (storedActorId && storedActorId !== eventActorId) {
    throw new SessionAccessDeniedError(session.sessionId);
  }

  if (storedConversationId && storedConversationId !== eventConversationId) {
    throw new SessionAccessDeniedError(session.sessionId);
  }
}

function cleanScopeValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function titleFromText(text: string): string | undefined {
  const cleaned = text.trim().replace(/\s+/g, ' ');
  if (!cleaned) {
    return undefined;
  }
  return cleaned.length > 80 ? `${cleaned.slice(0, 77)}...` : cleaned;
}
