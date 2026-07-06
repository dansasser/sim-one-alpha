import type { Hono } from 'hono';
import {
  isSessionCreationSlashCommand,
  isSupportedSlashCommand,
  parseSlashCommand,
  type ParsedSlashCommand,
} from '../../engine/commands/slash-commands.js';
import { normalizeWebApiMessage, type WebApiMessageInput } from '../../api/connectors/web-api.js';
import { goromboPersistenceRuntime } from '../../db.js';
import { requireApiSecret, runtimeEnvForRequest } from '../../api/middleware/api-secret.js';
import { configureRuntimeModels } from '../../core/models/index.js';
import { calculateContextBudget } from '../../engine/session/context-budget.js';
import { directAgentHarnessName, directAgentSessionName } from '../../engine/session/direct-agent-session.js';
import {
  openDurableOrchestratorSession,
  type DurableOrchestratorSessionOpener,
} from '../../engine/session/durable-orchestrator-session.js';
import {
  createSessionBudgetReport,
  recordManualCompaction,
  type SessionBudgetReport,
} from '../../engine/session/session-budget.js';
import {
  isGuiSessionManagedConnector,
  listChatSessions,
  resolveChatSession,
  SessionAccessDeniedError,
  type ChatSessionResolution,
} from '../../engine/session/session-routing.js';
import { createChatPrompt } from '../../api/routes/chat-prompt.js';

export interface ChatEventRouteOptions {
  openDurableSession?: DurableOrchestratorSessionOpener;
}

export function registerChatEventRoutes(app: Hono, options: ChatEventRouteOptions = {}): void {
  const openDurableSession = options.openDurableSession ?? openDurableOrchestratorSession;

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
        text: `Unknown command "${slashCommand.raw}". Supported commands are /new, /resume, /rename, and /compact.`,
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

    if (slashCommand?.name === 'resume' && !slashCommand.args) {
      goromboPersistenceRuntime.sessionDatabase.recordNormalizedMessageEvent({ event });
      return c.json(createCommandResponse({
        eventId: event.id,
        command: slashCommand,
        text: 'Usage: /resume <session-id>',
      }), 400);
    }

    if (slashCommand?.name === 'rename' && !slashCommand.args) {
      goromboPersistenceRuntime.sessionDatabase.recordNormalizedMessageEvent({ event });
      return c.json(createCommandResponse({
        eventId: event.id,
        command: slashCommand,
        text: 'Usage: /rename <title>',
      }), 400);
    }

    const requestedSessionId = slashCommand?.name === 'resume'
      ? slashCommand.args
      : typeof (payload as { session?: unknown }).session === 'string'
        ? (payload as { session: string }).session
        : undefined;

    let sessionResolution: ChatSessionResolution;
    try {
      sessionResolution = resolveChatSession({
        event,
        requestedSessionId,
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

    if (slashCommand?.name === 'resume') {
      return c.json(createCommandResponse({
        eventId: event.id,
        sessionResolution,
        command: slashCommand,
        text: `Resumed session ${sessionResolution.sessionId}.`,
      }));
    }

    if (slashCommand?.name === 'rename') {
      goromboPersistenceRuntime.sessionDatabase.touchChatSession(
        sessionResolution.sessionId,
        slashCommand.args,
      );

      return c.json(createCommandResponse({
        eventId: event.id,
        sessionResolution,
        command: slashCommand,
        text: `Renamed session ${sessionResolution.sessionId} to "${slashCommand.args}".`,
      }));
    }

    if (slashCommand?.name === 'compact') {
      const runtimeEnv = runtimeEnvForRequest(c.env as Record<string, unknown> | undefined);
      const contextBudget = await compactDurableChatSession({
        sessionResolution,
        command: slashCommand,
        env: runtimeEnv,
        openDurableSession,
      });

      return c.json(createCommandResponse({
        eventId: event.id,
        sessionResolution,
        command: slashCommand,
        text: `Compacted session ${sessionResolution.sessionId}.`,
        contextBudget,
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
  contextBudget?: DurableChatContextBudget;
}): {
  result: {
    text: string;
    command: {
      name: string;
      handled: boolean;
    };
    contextBudget?: DurableChatContextBudget;
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
      ...(input.contextBudget ? { contextBudget: input.contextBudget } : {}),
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

interface DurableChatContextBudget extends SessionBudgetReport {
  compactedBeforePrompt: boolean;
  prePromptStatus: SessionBudgetReport['status'];
  prePromptEstimatedUsedTokens: number;
  lastPromptEstimateTokens: number;
}

async function compactDurableChatSession(input: {
  sessionResolution: ChatSessionResolution;
  command: ParsedSlashCommand;
  env: Record<string, unknown>;
  openDurableSession: DurableOrchestratorSessionOpener;
}): Promise<DurableChatContextBudget> {
  const modelCard = configureRuntimeModels(input.env).selectedModelCard;
  const sessionId = input.sessionResolution.sessionId;
  const session = await input.openDurableSession({
    sessionId,
    env: input.env,
    payload: {
      command: input.command.raw,
    },
  });

  await session.compact();

  const sessionData = await goromboPersistenceRuntime.getLatestSessionDataForInstance(
    sessionId,
    directAgentHarnessName,
    directAgentSessionName,
  );

  if (!sessionData) {
    recordManualCompaction({
      sessionId,
      modelSpecifier: modelCard.specifier,
      budget: calculateContextBudget(modelCard),
    });
  }

  const contextBudget = createSessionBudgetReport({
    sessionId,
    modelCard,
    sessionData,
  });

  return {
    ...contextBudget,
    compactedBeforePrompt: true,
    prePromptStatus: contextBudget.status,
    prePromptEstimatedUsedTokens: contextBudget.estimatedUsedTokens,
    lastPromptEstimateTokens: contextBudget.estimatedPromptTokens,
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
  const submission = isRecord(body.submission) ? body.submission : undefined;
  const submissionId = typeof submission?.id === 'string' && submission.id.trim()
    ? submission.id.trim()
    : undefined;
  if (submissionId) {
    return submissionId;
  }

  const offset = typeof body.offset === 'string' ? body.offset : undefined;
  const streamUrl = typeof body.streamUrl === 'string' ? body.streamUrl : undefined;
  if (!offset && !streamUrl) {
    return undefined;
  }
  return [streamUrl ?? '', offset ?? ''].join('#');
}
