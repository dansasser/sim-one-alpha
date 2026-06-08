import type { FlueContext, PromptResponse, WorkflowRouteHandler } from '@flue/runtime';
import orchestratorAgent from '../agents/orchestrator.js';
import { normalizeWebApiMessage, type WebApiMessageInput } from '../connectors/web-api.js';
import {
  configureRuntimeModels,
  modelSpecifierFromParts,
  resolveModelCard,
} from '../models/index.js';
import { calculateContextBudget, estimateTextTokens } from '../session/context-budget.js';
import {
  createSessionBudgetReport,
  recordManualCompaction,
  recordPromptUsage,
  type SessionBudgetReport,
} from '../session/session-budget.js';
import { goromboFlueSessionStore } from '../session/flue-session-store.js';

export const route: WorkflowRouteHandler = async (_c, next) => next();

export interface ChatWorkflowPayload extends WebApiMessageInput {
  session?: string;
}

const orchestratorHarnessName = 'gorombo-orchestrator';

export interface ChatWorkflowResponse {
  text: string;
  model: PromptResponse['model'];
  usage: PromptResponse['usage'];
  event: ReturnType<typeof normalizeWebApiMessage>;
  contextBudget?: ChatWorkflowContextBudget;
}

export interface ChatWorkflowContextBudget extends SessionBudgetReport {
  compactedBeforePrompt: boolean;
  prePromptStatus: SessionBudgetReport['status'];
  prePromptEstimatedUsedTokens: number;
  lastPromptEstimateTokens: number;
}

export async function run({
  env,
  init,
  payload,
}: FlueContext<ChatWorkflowPayload>): Promise<ChatWorkflowResponse> {
  const event = normalizeWebApiMessage(payload);
  const sessionId = payload.session ?? event.conversation.id;
  const prompt = createChatPrompt(event);
  const runtimeModels = configureRuntimeModels(env);
  const selectedModelCard = resolveModelCard(runtimeModels.defaultAgentModel);
  const harness = await init(orchestratorAgent, { name: orchestratorHarnessName });
  const session = await harness.session(sessionId);
  let sessionData = goromboFlueSessionStore.getLatestSessionData(orchestratorHarnessName, sessionId);
  let compactedBeforePrompt = false;
  let contextBudget = selectedModelCard
    ? createSessionBudgetReport({
        sessionId,
        modelCard: selectedModelCard,
        promptText: prompt,
        sessionData,
      })
    : undefined;
  let promptBudget = contextBudget;

  if (contextBudget?.shouldCompactBeforePrompt && selectedModelCard) {
    await session.compact();
    sessionData = goromboFlueSessionStore.getLatestSessionData(orchestratorHarnessName, sessionId);
    if (!sessionData) {
      recordManualCompaction({
        sessionId,
        modelSpecifier: selectedModelCard.specifier,
        budget: calculateContextBudget(selectedModelCard),
      });
    }
    compactedBeforePrompt = true;
    contextBudget = createSessionBudgetReport({
      sessionId,
      modelCard: selectedModelCard,
      promptText: prompt,
      sessionData,
    });
    promptBudget = contextBudget;
  }

  if (contextBudget?.status === 'stop' && selectedModelCard) {
    return {
      text:
        `This message is too large for ${selectedModelCard.displayName}'s safe input budget after session compaction. ` +
        'Send a shorter message or switch to a larger model profile.',
      model: {
        provider: selectedModelCard.providerId,
        id: selectedModelCard.modelId,
      },
      usage: emptyPromptUsage(),
      event,
      contextBudget: {
        ...contextBudget,
        compactedBeforePrompt,
        prePromptStatus: contextBudget.status,
        prePromptEstimatedUsedTokens: contextBudget.estimatedUsedTokens,
        lastPromptEstimateTokens: contextBudget.estimatedPromptTokens,
      },
    };
  }

  const response = await session.prompt(prompt);
  sessionData = goromboFlueSessionStore.getLatestSessionData(orchestratorHarnessName, sessionId);
  const responseSpecifier = modelSpecifierFromParts(response.model.provider, response.model.id);
  const responseModelCard = resolveModelCard(responseSpecifier) ?? selectedModelCard;

  if (responseModelCard) {
    recordPromptUsage({
      sessionId,
      modelSpecifier: responseModelCard.specifier,
      promptEstimateTokens: contextBudget?.estimatedPromptTokens ?? estimateTextTokens(prompt),
      usage: response.usage,
    });

    contextBudget = createSessionBudgetReport({
      sessionId,
      modelCard: responseModelCard,
      sessionData,
    });
  }

  return {
    text: response.text,
    model: response.model,
    usage: response.usage,
    event,
    contextBudget: contextBudget
      ? {
          ...contextBudget,
          compactedBeforePrompt,
          prePromptStatus: promptBudget?.status ?? contextBudget.status,
          prePromptEstimatedUsedTokens: promptBudget?.estimatedUsedTokens ?? contextBudget.estimatedUsedTokens,
          lastPromptEstimateTokens: promptBudget?.estimatedPromptTokens ?? 0,
        }
      : undefined,
  };
}

export function createContextBudgetReport(modelSpecifier: string): SessionBudgetReport | undefined {
  const modelCard = resolveModelCard(modelSpecifier);
  return modelCard ? createSessionBudgetReport({ modelCard }) : undefined;
}

export function createChatPrompt(event: ReturnType<typeof normalizeWebApiMessage>): string {
  return `
You are handling a normalized GOROMBO chat event.

Before you answer:
1. Use the load_protocols tool for this event.
2. Use retrieve_context when the user asks for current, external, web, or source-backed information. Web search uses Ollama Search when configured. The tool can pack results with maxContextTokens and can use webFetch auto, always, or never.
3. Use the Flue task tool with agent: "researcher" when the user asks to research, compare sources, or perform multi-step web/source investigation.
4. Use retrieve_memory when stored conversation or project memory would help.
5. If metadata.providerFailures reports a failed source, say that plainly when it affects confidence and continue with the best available context.
6. If a specific provider is still a placeholder, say that plainly and continue with the best available answer.

Event:
${JSON.stringify(event, null, 2)}

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
