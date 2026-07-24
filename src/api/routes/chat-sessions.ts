import type { Hono } from 'hono';
import * as v from 'valibot';
import { goromboPersistenceRuntime } from '../../db.js';
import { requireApiSecret } from '../../api/middleware/api-secret.js';
import {
  ChatSessionAmbiguousError,
  ChatSessionNotFoundError,
  createFreshChatSession,
  listOwnedChatSessions,
  resumeOwnedChatSession,
  SessionAccessDeniedError,
  type ChatSessionIdentity,
  type ChatSessionResolution,
} from '../../engine/session/session-routing.js';
import {
  decodeTranscriptCursor,
  loadSessionTranscriptPage,
} from '../../engine/session/session-transcript.js';

const NonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.minLength(1));
const TuiSessionIdentitySchema = v.object({
  connector: v.literal('tui'),
  actorId: NonEmptyStringSchema,
  conversationId: NonEmptyStringSchema,
  threadId: v.optional(NonEmptyStringSchema),
});

export interface ChatSessionRouteOptions {
  loadTranscript?: typeof loadSessionTranscriptPage;
}

export function registerChatSessionRoutes(
  app: Hono,
  options: ChatSessionRouteOptions = {},
): void {
  app.post('/api/chat/sessions', requireApiSecret, async (c) => {
    const identity = await readIdentityPayload(c.req);
    if (!identity) {
      return c.json({ error: 'connector, actorId, and conversationId are required for TUI sessions.' }, 400);
    }

    return c.json(toLifecycleResponse(createFreshChatSession({ identity })), 201);
  });

  app.post('/api/chat/sessions/:sessionId/resume', requireApiSecret, async (c) => {
    const identity = await readIdentityPayload(c.req);
    if (!identity) {
      return c.json({ error: 'connector, actorId, and conversationId are required for TUI sessions.' }, 400);
    }

    const sessionId = c.req.param('sessionId').trim();
    if (!sessionId) {
      return c.json({ error: 'sessionId is required.' }, 400);
    }

    try {
      return c.json(toLifecycleResponse(resumeOwnedChatSession({ identity, sessionId })));
    } catch (error) {
      if (error instanceof SessionAccessDeniedError) {
        return c.json({ error: error.message }, 403);
      }
      if (error instanceof ChatSessionAmbiguousError) {
        return c.json({ error: error.message }, 409);
      }
      if (error instanceof ChatSessionNotFoundError) {
        return c.json(toLifecycleResponse(createFreshChatSession({ identity })), 201);
      }
      throw error;
    }
  });

  app.get('/api/chat/sessions', requireApiSecret, (c) => {
    const identityResult = v.safeParse(TuiSessionIdentitySchema, {
      connector: c.req.query('connector'),
      actorId: c.req.query('actorId'),
      conversationId: c.req.query('conversationId'),
      threadId: c.req.query('threadId'),
    });
    if (!identityResult.success) {
      return c.json({ error: 'connector, actorId, and conversationId are required for TUI sessions.' }, 400);
    }

    const limit = parseLimit(c.req.query('limit'));
    if (limit === null) {
      return c.json({ error: 'limit must be an integer from 1 to 100.' }, 400);
    }

    return c.json({
      sessions: listOwnedChatSessions({
        identity: identityResult.output,
        limit,
      }),
    });
  });

  app.get('/api/chat/sessions/:sessionId/transcript', requireApiSecret, async (c) => {
    const identityResult = v.safeParse(TuiSessionIdentitySchema, {
      connector: c.req.query('connector'),
      actorId: c.req.query('actorId'),
      conversationId: c.req.query('conversationId'),
      threadId: c.req.query('threadId'),
    });
    if (!identityResult.success) {
      return c.json({ error: 'connector, actorId, and conversationId are required for TUI sessions.' }, 400);
    }

    const limit = parseLimit(c.req.query('limit'));
    if (limit === null) {
      return c.json({ error: 'limit must be an integer from 1 to 100.' }, 400);
    }
    const before = c.req.query('before');
    if (before) {
      try {
        decodeTranscriptCursor(before);
      } catch {
        return c.json({ error: 'before must be a valid transcript cursor.' }, 400);
      }
    }

    const requestedSessionId = c.req.param('sessionId').trim();
    if (!requestedSessionId) {
      return c.json({ error: 'sessionId is required.' }, 400);
    }

    try {
      const resolution = resumeOwnedChatSession({
        identity: identityResult.output,
        sessionId: requestedSessionId,
      });
      if (resolution.sessionId !== requestedSessionId) {
        return c.json({ error: `Session ${requestedSessionId} does not exist.` }, 404);
      }
      const eventStreamStore = await goromboPersistenceRuntime.getEventStreamStore();
      const loadTranscript = options.loadTranscript ?? loadSessionTranscriptPage;
      return c.json(await loadTranscript({
        session: {
          id: resolution.sessionId,
          ...(resolution.session.displayName ? { title: resolution.session.displayName } : {}),
        },
        sessionDatabase: goromboPersistenceRuntime.sessionDatabase,
        eventStreamStore,
        limit,
        ...(before ? { before } : {}),
      }));
    } catch (error) {
      if (error instanceof SessionAccessDeniedError) {
        return c.json({ error: error.message }, 403);
      }
      if (error instanceof ChatSessionNotFoundError
        || isErrorNamed(error, 'ChatSessionAmbiguousError')) {
        return c.json({ error: `Session ${requestedSessionId} does not exist.` }, 404);
      }
      console.error('[WARN] Transcript history unavailable:', errorName(error));
      return c.json({ error: 'Session history is not available.' }, 500);
    }
  });
}

async function readIdentityPayload(request: { json(): Promise<unknown> }): Promise<ChatSessionIdentity | null> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return null;
  }

  const result = v.safeParse(TuiSessionIdentitySchema, payload);
  return result.success ? result.output : null;
}

function parseLimit(value: string | undefined): number | null {
  if (value === undefined || value === '') {
    return 50;
  }
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return parsed >= 1 && parsed <= 100 ? parsed : null;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function isErrorNamed(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

function toLifecycleResponse(resolution: ChatSessionResolution): {
  session: {
    id: string;
    surface: ChatSessionResolution['surface'];
    created: boolean;
    title?: string;
  };
} {
  return {
    session: {
      id: resolution.sessionId,
      surface: resolution.surface,
      created: resolution.created,
      ...(resolution.session.displayName ? { title: resolution.session.displayName } : {}),
    },
  };
}
