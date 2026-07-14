import type { Hono } from 'hono';
import * as v from 'valibot';
import { requireApiSecret } from '../../api/middleware/api-secret.js';
import {
  ChatSessionNotFoundError,
  createFreshChatSession,
  listOwnedChatSessions,
  resumeOwnedChatSession,
  SessionAccessDeniedError,
  type ChatSessionIdentity,
  type ChatSessionResolution,
} from '../../engine/session/session-routing.js';

const NonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.minLength(1));
const TuiSessionIdentitySchema = v.object({
  connector: v.literal('tui'),
  actorId: NonEmptyStringSchema,
  conversationId: NonEmptyStringSchema,
  threadId: v.optional(NonEmptyStringSchema),
});

export function registerChatSessionRoutes(app: Hono): void {
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
      if (error instanceof ChatSessionNotFoundError) {
        return c.json({ error: error.message }, 404);
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
