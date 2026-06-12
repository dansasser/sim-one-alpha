import type { Hono } from 'hono';
import {
  isSessionCreationSlashCommand,
  isSupportedSlashCommand,
  parseSlashCommand,
  type ParsedSlashCommand,
} from '../commands/slash-commands.js';
import { normalizeWebApiMessage, type WebApiMessageInput } from '../connectors/web-api.js';
import { goromboPersistenceRuntime } from '../db.js';
import { requireApiSecret, runtimeEnvForRequest } from '../middleware/api-secret.js';
import {
  isGuiSessionManagedConnector,
  listChatSessions,
  resolveChatSession,
  SessionAccessDeniedError,
  type ChatSessionResolution,
} from '../session/session-routing.js';
import { createChatPrompt } from '../workflows/chat.js';

export function registerChatEventRoutes(app: Hono): void {
  app.get('/api/chat/sessions', requireApiSecret, (c) => {
    const parsedLimit = Number.parseInt(c.req.query('limit') ?? '', 10);
    const limit = Number.isInteger(parsedLimit)
      ? Math.min(100, Math.max(1, parsedLimit))
      : 50;
    return c.json({
      sessions: listChatSessions(limit),
    });
  });

  app.post('/api/chat/events', requireApiSecret, async (c) => {
    const headers = new Headers(c.req.raw.headers);
    headers.set('content-type', 'application/json');
    let payload: unknown;

    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON payload' }, 400);
    }

    const event = normalizeWebApiMessage(payload as WebApiMessageInput);
    const slashCommand = parseSlashCommand(event.text);

    if (slashCommand && !isSupportedSlashCommand(slashCommand)) {
      goromboPersistenceRuntime.sessionDatabase.recordNormalizedMessageEvent({ event });
      return c.json(createCommandResponse({
        eventId: event.id,
        command: slashCommand,
        text: `Unknown command "${slashCommand.raw}". Supported commands are /new and /compact.`,
      }));
    }

    if (slashCommand && isGuiSessionManagedConnector(event.connector) && isSessionCreationSlashCommand(slashCommand)) {
      goromboPersistenceRuntime.sessionDatabase.recordNormalizedMessageEvent({ event });
      return c.json(createCommandResponse({
        eventId: event.id,
        command: slashCommand,
        text: '/new is handled by the web client session controls. Use the new chat action instead.',
      }));
    }

    let sessionResolution: ChatSessionResolution;
    try {
      sessionResolution = resolveChatSession({
        event,
        requestedSessionId: typeof (payload as { session?: unknown }).session === 'string'
          ? (payload as { session: string }).session
          : undefined,
        forceNew: slashCommand?.name === 'new',
        title: slashCommand?.name === 'new' && slashCommand.args ? slashCommand.args : undefined,
      });
    } catch (error) {
      goromboPersistenceRuntime.sessionDatabase.recordNormalizedMessageEvent({ event });
      if (error instanceof SessionAccessDeniedError) {
        return c.json({ error: error.message, eventId: event.id }, 403);
      }
      throw error;
    }

    goromboPersistenceRuntime.sessionDatabase.recordNormalizedMessageEvent({
      event,
      sessionId: sessionResolution.sessionId,
      deliveryKind: 'direct-agent',
    });

    if (slashCommand?.name === 'new') {
      return c.json(createCommandResponse({
        eventId: event.id,
        sessionResolution,
        command: slashCommand,
        text: `Started new session ${sessionResolution.sessionId}.`,
      }));
    }

    if (slashCommand?.name === 'compact') {
      return c.json(createCommandResponse({
        eventId: event.id,
        sessionResolution,
        command: slashCommand,
        text:
          'Manual /compact is not available through durable chat ingress yet. ' +
          'The orchestrator still uses Flue automatic compaction for durable agent sessions.',
      }));
    }

    const agentResponse = await app.request(
      `/agents/orchestrator/${encodeURIComponent(sessionResolution.sessionId)}?wait=result`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ message: createChatPrompt(event) }),
      },
      runtimeEnvForRequest(c.env as Record<string, unknown> | undefined),
    );

    const body = await readJsonResponse(agentResponse.clone());
    if (isRecord(body)) {
      const deliveryId = readDeliveryId(body);
      if (deliveryId) {
        goromboPersistenceRuntime.sessionDatabase.recordNormalizedMessageEvent({
          event,
          sessionId: sessionResolution.sessionId,
          deliveryKind: 'direct-agent',
          deliveryId,
        });
      }

      return c.json({
        ...body,
        event: {
          id: event.id,
          connector: event.connector,
          messageKind: event.kind,
          receivedAt: event.receivedAt,
        },
        session: {
          id: sessionResolution.sessionId,
          surface: sessionResolution.surface,
          created: sessionResolution.created,
        },
      }, agentResponse.status as never);
    }

    return new Response(await agentResponse.text(), {
      status: agentResponse.status,
      headers: agentResponse.headers,
    });
  });
}

function createCommandResponse(input: {
  eventId: string;
  command: ParsedSlashCommand;
  text: string;
  sessionResolution?: ChatSessionResolution;
}): {
  result: {
    text: string;
    command: {
      name: string;
      handled: boolean;
    };
  };
  event: {
    id: string;
  };
  session?: {
    id: string;
    surface: ChatSessionResolution['surface'];
    created: boolean;
  };
} {
  return {
    result: {
      text: input.text,
      command: {
        name: input.command.name,
        handled: true,
      },
    },
    event: {
      id: input.eventId,
    },
    ...(input.sessionResolution
      ? {
          session: {
            id: input.sessionResolution.sessionId,
            surface: input.sessionResolution.surface,
            created: input.sessionResolution.created,
          },
        }
      : {}),
  };
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readDeliveryId(body: Record<string, unknown>): string | undefined {
  const offset = typeof body.offset === 'string' ? body.offset : undefined;
  const streamUrl = typeof body.streamUrl === 'string' ? body.streamUrl : undefined;
  if (!offset && !streamUrl) {
    return undefined;
  }
  return [streamUrl ?? '', offset ?? ''].join('#');
}
