import type { FlueContext, FlueSession, PromptResponse, WorkflowRouteHandler } from '@flue/runtime';
import orchestratorAgent from '../agents/orchestrator.js';
import {
  isSupportedSlashCommand,
  isWebDisabledSlashCommand,
  parseSlashCommand,
  type ParsedSlashCommand,
} from '../commands/slash-commands.js';
import { normalizeWebApiMessage, type WebApiMessageInput } from '../connectors/web-api.js';
import { goromboPersistenceRuntime } from '../db.js';
import { requireApiSecret } from '../middleware/api-secret.js';
import {
  configureRuntimeModels,
  modelSpecifierFromParts,
  resolveModelCard,
} from '../models/index.js';
import type { AgentModelCard } from '../models/types.js';
import { calculateContextBudget, estimateTextTokens } from '../session/context-budget.js';
import {
  createSessionBudgetReport,
  recordManualCompaction,
  recordPromptUsage,
  type SessionBudgetReport,
} from '../session/session-budget.js';
import {
  resolveChatSession,
  type ChatSessionResolution,
} from '../session/session-routing.js';
import { rememberProtocolLookupEvent } from '../tools/protocol-tool.js';

export const route: WorkflowRouteHandler = async (c, next) => requireApiSecret(c, next);

export interface ChatWorkflowPayload extends WebApiMessageInput {
  session?: string;
}

const orchestratorHarnessName = 'gorombo-orchestrator';

export interface ChatWorkflowResponse {
  text: string;
  model: PromptResponse['model'];
  usage: PromptResponse['usage'];
  event: ReturnType<typeof normalizeWebApiMessage>;
  session?: {
    id: string;
    surface: ChatSessionResolution['surface'];
    created: boolean;
  };
  command?: {
    name: string;
    handled: boolean;
  };
  contextBudget?: ChatWorkflowContextBudget;
  modelFailover?: ChatWorkflowModelFailover;
}

export interface ChatWorkflowContextBudget extends SessionBudgetReport {
  compactedBeforePrompt: boolean;
  prePromptStatus: SessionBudgetReport['status'];
  prePromptEstimatedUsedTokens: number;
  lastPromptEstimateTokens: number;
}

export interface ChatWorkflowModelFailover {
  fallbackUsed: boolean;
  attempts: ChatWorkflowModelAttempt[];
}

export interface ChatWorkflowModelAttempt {
  role: 'primary' | 'backup';
  modelCardKey: string;
  modelSpecifier: string;
  displayName: string;
  status: 'failed' | 'used' | 'skipped';
  error?: string;
  reason?: string;
}

export async function run({
  env,
  init,
  payload,
}: FlueContext<ChatWorkflowPayload>): Promise<ChatWorkflowResponse> {
  const event = normalizeWebApiMessage(payload);
  rememberProtocolLookupEvent(event);
  const runtimeModels = configureRuntimeModels(env);
  const selectedModelCard = runtimeModels.selectedModelCard;
  const backupModelCard = runtimeModels.backupModelCard;
  const slashCommand = parseSlashCommand(event.text);

  if (slashCommand && !isSupportedSlashCommand(slashCommand)) {
    return createSlashCommandResponse({
      event,
      modelCard: selectedModelCard,
      command: slashCommand,
      text: `Unknown command "${slashCommand.raw}". Supported commands are /new and /compact.`,
    });
  }

  if (slashCommand && event.connector === 'web-api' && isWebDisabledSlashCommand(slashCommand)) {
    return createSlashCommandResponse({
      event,
      modelCard: selectedModelCard,
      command: slashCommand,
      text: '/new is handled by the web client session controls. Use the new chat action instead.',
    });
  }

  const sessionResolution = resolveChatSession({
    event,
    requestedSessionId: payload.session,
    forceNew: slashCommand?.name === 'new',
    title: slashCommand?.name === 'new' && slashCommand.args ? slashCommand.args : undefined,
  });
  const sessionId = sessionResolution.sessionId;

  if (slashCommand?.name === 'new') {
    return createSlashCommandResponse({
      event,
      modelCard: selectedModelCard,
      sessionResolution,
      command: slashCommand,
      text: `Started new session ${sessionId}.`,
    });
  }

  const prompt = createChatPrompt(event);
  const harness = await init(orchestratorAgent, { name: orchestratorHarnessName });
  const session = await harness.session(sessionId);
  const attempts: ChatWorkflowModelAttempt[] = [];

  if (slashCommand?.name === 'compact') {
    return handleCompactCommand({
      event,
      session,
      sessionId,
      selectedModelCard,
      sessionResolution,
      command: slashCommand,
    });
  }

  let preparedPrompt = await preparePromptBudget({
    session,
    sessionId,
    modelCard: selectedModelCard,
    prompt,
  });

  if (preparedPrompt.contextBudget.status === 'stop') {
    return createBudgetStopResponse({
      event,
      sessionResolution,
      preparedPrompt,
    });
  }

  let response: PromptResponse;

  try {
    response = await promptWithModelCard({
      session,
      prompt,
      modelCard: selectedModelCard,
      role: 'primary',
      attempts,
    });
  } catch (error) {
    if (!backupModelCard || !isRecoverableModelFailure(error)) {
      throw error;
    }

    preparedPrompt = await preparePromptBudget({
      session,
      sessionId,
      modelCard: backupModelCard,
      prompt,
      compactedBeforePrompt: preparedPrompt.compactedBeforePrompt,
    });

    if (preparedPrompt.contextBudget.status === 'stop') {
      attempts.push(createSkippedAttempt(backupModelCard, 'backup', 'backup model context budget would be exceeded'));
      return createBudgetStopResponse({
        event,
        sessionResolution,
        preparedPrompt,
        modelFailover: {
          fallbackUsed: false,
          attempts,
        },
        textPrefix: `${selectedModelCard.displayName} was unavailable, but `,
      });
    }

    response = await promptWithModelCard({
      session,
      prompt,
      modelCard: backupModelCard,
      role: 'backup',
      attempts,
    });
  }

  let sessionData = await goromboPersistenceRuntime.getLatestSessionData(orchestratorHarnessName, sessionId);
  const responseSpecifier = modelSpecifierFromParts(response.model.provider, response.model.id);
  const responseModelCard = resolveModelCard(responseSpecifier) ?? preparedPrompt.modelCard;

  recordPromptUsage({
    sessionId,
    modelSpecifier: responseModelCard.specifier,
    promptEstimateTokens: preparedPrompt.contextBudget.estimatedPromptTokens ?? estimateTextTokens(prompt),
    usage: response.usage,
  });

  const contextBudget = createSessionBudgetReport({
    sessionId,
    modelCard: responseModelCard,
    sessionData,
  });

  return {
    text: response.text,
    model: response.model,
    usage: response.usage,
    event,
    session: {
      id: sessionResolution.sessionId,
      surface: sessionResolution.surface,
      created: sessionResolution.created,
    },
    contextBudget: {
      ...contextBudget,
      compactedBeforePrompt: preparedPrompt.compactedBeforePrompt,
      prePromptStatus: preparedPrompt.promptBudget.status,
      prePromptEstimatedUsedTokens: preparedPrompt.promptBudget.estimatedUsedTokens,
      lastPromptEstimateTokens: preparedPrompt.promptBudget.estimatedPromptTokens,
    },
    modelFailover: attempts.some((attempt) => attempt.role === 'backup' && attempt.status === 'used')
      ? {
          fallbackUsed: true,
          attempts,
        }
      : undefined,
  };
}

export function createContextBudgetReport(modelSpecifier: string): SessionBudgetReport | undefined {
  const modelCard = resolveModelCard(modelSpecifier);
  return modelCard ? createSessionBudgetReport({ modelCard }) : undefined;
}

export function createChatPrompt(event: ReturnType<typeof normalizeWebApiMessage>): string {
  const safeEvent = {
    connector: event.connector,
    messageKind: event.kind,
    receivedAt: event.receivedAt,
    ...(event.actor.displayName ? { actorDisplayName: event.actor.displayName } : {}),
    ...(event.context?.workflow ? { workflow: event.context.workflow } : {}),
    ...(event.context?.task ? { task: event.context.task } : {}),
    text: event.text,
  };

  return `
You are handling a normalized GOROMBO chat event.

Before you answer:
1. Use the load_protocols tool for this event with eventId: "${event.id}". Do not pass or invent clientId, projectId, raw payloads, or other hidden identifiers.
2. Do not perform web search directly and do not call web-capable retrieval tools from the orchestrator.
3. Use the Flue task tool with agent: "researcher" for any current, external, web, source-backed, or research task. The researcher owns web_research and decides how many searches or fetches are needed.
4. Use retrieve_memory when stored conversation or project memory would help.
5. If research metadata reports providerFailures, say that plainly when it affects confidence and continue with the best available context.
6. If a specific provider is still a placeholder, say that plainly and continue with the best available answer.

Safe event:
${JSON.stringify(safeEvent, null, 2)}

Answer the user message naturally and keep the response concise.
`;
}

function emptyPromptUsage(): PromptResponse['usage'] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

async function handleCompactCommand(input: {
  event: ReturnType<typeof normalizeWebApiMessage>;
  session: FlueSession;
  sessionId: string;
  selectedModelCard: AgentModelCard;
  sessionResolution: ChatSessionResolution;
  command: ParsedSlashCommand;
}): Promise<ChatWorkflowResponse> {
  await input.session.compact();
  const sessionData = await goromboPersistenceRuntime.getLatestSessionData(orchestratorHarnessName, input.sessionId);

  if (!sessionData) {
    recordManualCompaction({
      sessionId: input.sessionId,
      modelSpecifier: input.selectedModelCard.specifier,
      budget: calculateContextBudget(input.selectedModelCard),
    });
  }

  const contextBudget = createSessionBudgetReport({
    sessionId: input.sessionId,
    modelCard: input.selectedModelCard,
    sessionData,
  });

  return createSlashCommandResponse({
    event: input.event,
    modelCard: input.selectedModelCard,
    sessionResolution: input.sessionResolution,
    command: input.command,
    text: `Compacted session ${input.sessionId}.`,
    contextBudget,
  });
}

function createSlashCommandResponse(input: {
  event: ReturnType<typeof normalizeWebApiMessage>;
  modelCard: AgentModelCard;
  command: ParsedSlashCommand;
  text: string;
  sessionResolution?: ChatSessionResolution;
  contextBudget?: SessionBudgetReport;
}): ChatWorkflowResponse {
  return {
    text: input.text,
    model: {
      provider: input.modelCard.providerId,
      id: input.modelCard.modelId,
    },
    usage: emptyPromptUsage(),
    event: input.event,
    ...(input.sessionResolution
      ? {
          session: {
            id: input.sessionResolution.sessionId,
            surface: input.sessionResolution.surface,
            created: input.sessionResolution.created,
          },
        }
      : {}),
    command: {
      name: input.command.name,
      handled: true,
    },
    ...(input.contextBudget
      ? {
          contextBudget: {
            ...input.contextBudget,
            compactedBeforePrompt: true,
            prePromptStatus: input.contextBudget.status,
            prePromptEstimatedUsedTokens: input.contextBudget.estimatedUsedTokens,
            lastPromptEstimateTokens: input.contextBudget.estimatedPromptTokens,
          },
        }
      : {}),
  };
}

interface PreparedPromptBudget {
  modelCard: AgentModelCard;
  contextBudget: SessionBudgetReport;
  promptBudget: SessionBudgetReport;
  compactedBeforePrompt: boolean;
}

async function preparePromptBudget(input: {
  session: FlueSession;
  sessionId: string;
  modelCard: AgentModelCard;
  prompt: string;
  compactedBeforePrompt?: boolean;
}): Promise<PreparedPromptBudget> {
  let sessionData = await goromboPersistenceRuntime.getLatestSessionData(orchestratorHarnessName, input.sessionId);
  let compactedBeforePrompt = input.compactedBeforePrompt ?? false;
  let contextBudget = createSessionBudgetReport({
    sessionId: input.sessionId,
    modelCard: input.modelCard,
    promptText: input.prompt,
    sessionData,
  });
  let promptBudget = contextBudget;

  if (contextBudget.shouldCompactBeforePrompt) {
    await input.session.compact();
    sessionData = await goromboPersistenceRuntime.getLatestSessionData(orchestratorHarnessName, input.sessionId);
    if (!sessionData) {
      recordManualCompaction({
        sessionId: input.sessionId,
        modelSpecifier: input.modelCard.specifier,
        budget: calculateContextBudget(input.modelCard),
      });
    }
    compactedBeforePrompt = true;
    contextBudget = createSessionBudgetReport({
      sessionId: input.sessionId,
      modelCard: input.modelCard,
      promptText: input.prompt,
      sessionData,
    });
    promptBudget = contextBudget;
  }

  return {
    modelCard: input.modelCard,
    contextBudget,
    promptBudget,
    compactedBeforePrompt,
  };
}

async function promptWithModelCard(input: {
  session: FlueSession;
  prompt: string;
  modelCard: AgentModelCard;
  role: 'primary' | 'backup';
  attempts: ChatWorkflowModelAttempt[];
}): Promise<PromptResponse> {
  try {
    const response = await input.session.prompt(input.prompt, { model: input.modelCard.specifier });
    input.attempts.push(createUsedAttempt(input.modelCard, input.role));
    return response;
  } catch (error) {
    input.attempts.push(createFailedAttempt(input.modelCard, input.role, errorMessage(error)));
    throw error;
  }
}

export function isRecoverableModelFailure(error: unknown): boolean {
  const message = errorMessage(error);
  const name = error instanceof Error ? error.name : '';
  const text = `${name} ${message}`.toLowerCase();

  if (text.includes('abort')) {
    return false;
  }

  return ![
    'context length',
    'context window',
    'context limit',
    'maximum context',
    'token limit',
    'too many tokens',
    'maximum input',
    'max input',
    'too large',
    'budget',
    'result unavailable',
    'schema validation',
  ].some((pattern) => text.includes(pattern));
}

function createBudgetStopResponse(input: {
  event: ReturnType<typeof normalizeWebApiMessage>;
  sessionResolution: ChatSessionResolution;
  preparedPrompt: PreparedPromptBudget;
  modelFailover?: ChatWorkflowModelFailover;
  textPrefix?: string;
}): ChatWorkflowResponse {
  const { modelCard, contextBudget, compactedBeforePrompt, promptBudget } = input.preparedPrompt;

  return {
    text:
      `${input.textPrefix ?? ''}this message is too large for ${modelCard.displayName}'s safe input budget after session compaction. ` +
      'Send a shorter message or switch to a larger model card.',
    model: {
      provider: modelCard.providerId,
      id: modelCard.modelId,
    },
    usage: emptyPromptUsage(),
    event: input.event,
    session: {
      id: input.sessionResolution.sessionId,
      surface: input.sessionResolution.surface,
      created: input.sessionResolution.created,
    },
    contextBudget: {
      ...contextBudget,
      compactedBeforePrompt,
      prePromptStatus: promptBudget.status,
      prePromptEstimatedUsedTokens: promptBudget.estimatedUsedTokens,
      lastPromptEstimateTokens: promptBudget.estimatedPromptTokens,
    },
    ...(input.modelFailover ? { modelFailover: input.modelFailover } : {}),
  };
}

function createUsedAttempt(modelCard: AgentModelCard, role: 'primary' | 'backup'): ChatWorkflowModelAttempt {
  return {
    role,
    modelCardKey: modelCard.key,
    modelSpecifier: modelCard.specifier,
    displayName: modelCard.displayName,
    status: 'used',
  };
}

function createFailedAttempt(
  modelCard: AgentModelCard,
  role: 'primary' | 'backup',
  error: string,
): ChatWorkflowModelAttempt {
  return {
    role,
    modelCardKey: modelCard.key,
    modelSpecifier: modelCard.specifier,
    displayName: modelCard.displayName,
    status: 'failed',
    error,
  };
}

function createSkippedAttempt(
  modelCard: AgentModelCard,
  role: 'primary' | 'backup',
  reason: string,
): ChatWorkflowModelAttempt {
  return {
    role,
    modelCardKey: modelCard.key,
    modelSpecifier: modelCard.specifier,
    displayName: modelCard.displayName,
    status: 'skipped',
    reason,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
