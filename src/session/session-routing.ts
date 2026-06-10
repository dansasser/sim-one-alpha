import { goromboPersistenceRuntime } from '../db.js';
import type { NormalizedMessageEvent } from '../types/index.js';
import type { ChatSessionRecord } from './session-database.js';

export type ChatSurface = 'web' | 'tui' | 'connector';

export interface ResolveChatSessionInput {
  event: NormalizedMessageEvent;
  requestedSessionId?: string;
  forceNew?: boolean;
  title?: string;
}

export interface ChatSessionResolution {
  sessionId: string;
  surface: ChatSurface;
  session: ChatSessionRecord;
  created: boolean;
}

export function resolveChatSession(input: ResolveChatSessionInput): ChatSessionResolution {
  const surface = surfaceForEvent(input.event);
  const activeLookup = {
    surface,
    connector: input.event.connector,
    actorId: input.event.actor.id,
    conversationId: input.event.conversation.id,
    threadId: input.event.conversation.threadId,
  };
  const explicitSessionId = cleanSessionId(input.requestedSessionId);
  const existingActiveSessionId =
    surface === 'connector' && !input.forceNew ? goromboPersistenceRuntime.sessionDatabase.getActiveSession(activeLookup) : null;
  const sessionId = explicitSessionId ?? existingActiveSessionId ?? undefined;
  const title = input.title ?? titleFromText(input.event.text);

  if (sessionId && !input.forceNew) {
    const session = goromboPersistenceRuntime.sessionDatabase.ensureChatSession({
      sessionId,
      origin: surface,
      actorId: input.event.actor.id,
      conversationId: input.event.conversation.id,
      threadId: input.event.conversation.threadId,
      title,
    });

    if (surface === 'connector') {
      goromboPersistenceRuntime.sessionDatabase.setActiveSession({
        ...activeLookup,
        sessionId,
      });
    }

    return {
      sessionId,
      surface,
      session,
      created: false,
    };
  }

  const session = goromboPersistenceRuntime.sessionDatabase.createChatSession({
    origin: surface,
    actorId: input.event.actor.id,
    conversationId: input.event.conversation.id,
    threadId: input.event.conversation.threadId,
    title,
  });

  if (surface === 'connector') {
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

function surfaceForEvent(event: NormalizedMessageEvent): ChatSurface {
  if (event.connector === 'web-api') {
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

function titleFromText(text: string): string | undefined {
  const cleaned = text.trim().replace(/\s+/g, ' ');
  if (!cleaned) {
    return undefined;
  }
  return cleaned.length > 80 ? `${cleaned.slice(0, 77)}...` : cleaned;
}
