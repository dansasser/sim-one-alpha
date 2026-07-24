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

export class ChatSessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} does not exist.`);
    this.name = 'ChatSessionNotFoundError';
  }
}

export class ChatSessionAmbiguousError extends Error {
  constructor(readonly sessionName: string) {
    super(`Multiple sessions are named ${sessionName}. Resume one by session id.`);
    this.name = 'ChatSessionAmbiguousError';
  }
}

export interface ChatSessionIdentity {
  connector: ConnectorKind;
  actorId: string;
  conversationId: string;
  threadId?: string;
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

export function createFreshChatSession(input: {
  identity: ChatSessionIdentity;
  sessionId?: string;
  title?: string;
  displayName?: string;
}): ChatSessionResolution {
  const surface = surfaceForConnector(input.identity.connector);
  const session = goromboPersistenceRuntime.sessionDatabase.createChatSession({
    sessionId: input.sessionId,
    origin: surface,
    actorId: input.identity.actorId,
    conversationId: input.identity.conversationId,
    threadId: input.identity.threadId,
    title: input.title,
    displayName: input.displayName,
  });

  if (connectorUsesPersistentSession(input.identity.connector)) {
    goromboPersistenceRuntime.sessionDatabase.setActiveSession({
      ...activeSessionLookup(input.identity, surface),
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

export function resumeOwnedChatSession(input: {
  identity: ChatSessionIdentity;
  sessionId: string;
}): ChatSessionResolution {
  const sessionSelector = cleanSessionId(input.sessionId) ?? input.sessionId;
  const surface = surfaceForConnector(input.identity.connector);
  const sessionById = goromboPersistenceRuntime.sessionDatabase.getChatSession(sessionSelector);
  if (sessionById) {
    assertSessionBelongsToIdentity(sessionById, input.identity, surface);
  }
  const namedSessions = sessionById
    ? []
    : goromboPersistenceRuntime.sessionDatabase.listChatSessionsByExplicitNameForScope({
      explicitName: sessionSelector,
      origin: surface,
      actorId: input.identity.actorId,
      conversationId: input.identity.conversationId,
      threadId: input.identity.threadId,
      limit: 2,
    });
  if (namedSessions.length > 1) {
    throw new ChatSessionAmbiguousError(sessionSelector);
  }
  const session = sessionById ?? namedSessions[0];
  if (!session) {
    throw new ChatSessionNotFoundError(sessionSelector);
  }

  const sessionId = session.sessionId;
  goromboPersistenceRuntime.sessionDatabase.touchChatSession(sessionId);
  const resumedSession = goromboPersistenceRuntime.sessionDatabase.getChatSession(sessionId)
    ?? session;

  if (connectorUsesPersistentSession(input.identity.connector)) {
    goromboPersistenceRuntime.sessionDatabase.setActiveSession({
      ...activeSessionLookup(input.identity, surface),
      sessionId,
    });
  }

  return {
    sessionId,
    surface,
    session: resumedSession,
    created: false,
  };
}

export function listOwnedChatSessions(input: {
  identity: ChatSessionIdentity;
  limit: number;
}): ChatSessionRecord[] {
  return goromboPersistenceRuntime.sessionDatabase.listChatSessionsForScope({
    origin: surfaceForConnector(input.identity.connector),
    actorId: input.identity.actorId,
    conversationId: input.identity.conversationId,
    threadId: input.identity.threadId,
    limit: input.limit,
  });
}

export function resolveChatSession(input: ResolveChatSessionInput): ChatSessionResolution {
  const identity = identityForEvent(input.event);
  const surface = surfaceForConnector(identity.connector);
  const persistentConnector = connectorUsesPersistentSession(input.event.connector);
  const explicitSessionId = cleanSessionId(input.requestedSessionId);
  const title = input.title ?? titleFromText(input.event.text);

  if (explicitSessionId && !input.forceNew) {
    try {
      return resumeOwnedChatSession({ identity, sessionId: explicitSessionId });
    } catch (error) {
      if (!(error instanceof ChatSessionNotFoundError)
        || !isGuiSessionManagedConnector(input.event.connector)) {
        throw error;
      }
      return createFreshChatSession({
        identity,
        sessionId: explicitSessionId,
        title,
        displayName: input.displayName,
      });
    }
  }

  if (persistentConnector && !input.forceNew) {
    const activeSessionId = goromboPersistenceRuntime.sessionDatabase.getActiveSession(
      activeSessionLookup(identity, surface),
    );
    if (activeSessionId) {
      return resumeOwnedChatSession({ identity, sessionId: activeSessionId });
    }
  }

  return createFreshChatSession({
    identity,
    title,
    displayName: input.displayName,
  });
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

function surfaceForConnector(connector: ConnectorKind): ChatSurface {
  if (isGuiSessionManagedConnector(connector)) {
    return 'web';
  }
  if (connector === 'tui') {
    return 'tui';
  }
  return 'connector';
}

function cleanSessionId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function identityForEvent(event: NormalizedMessageEvent): ChatSessionIdentity {
  return {
    connector: event.connector,
    actorId: event.actor.id,
    conversationId: event.conversation.id,
    threadId: event.conversation.threadId,
  };
}

function activeSessionLookup(identity: ChatSessionIdentity, surface: ChatSurface) {
  return {
    surface,
    connector: identity.connector,
    actorId: identity.actorId,
    conversationId: identity.conversationId,
    threadId: identity.threadId,
  };
}

function assertSessionBelongsToIdentity(
  session: ChatSessionRecord,
  identity: ChatSessionIdentity,
  surface: ChatSurface,
): void {
  const storedActorId = cleanScopeValue(session.actorId);
  const storedConversationId = cleanScopeValue(session.conversationId);
  const storedThreadId = cleanScopeValue(session.threadId);
  const identityActorId = cleanScopeValue(identity.actorId);
  const identityConversationId = cleanScopeValue(identity.conversationId);
  const identityThreadId = cleanScopeValue(identity.threadId);

  if (!storedActorId && !storedConversationId) {
    throw new SessionAccessDeniedError(session.sessionId);
  }

  if (session.origin !== surface) {
    throw new SessionAccessDeniedError(session.sessionId);
  }

  if (storedActorId !== identityActorId) {
    throw new SessionAccessDeniedError(session.sessionId);
  }

  if (storedConversationId !== identityConversationId) {
    throw new SessionAccessDeniedError(session.sessionId);
  }

  if (storedThreadId !== identityThreadId) {
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
