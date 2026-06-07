import type { FlueContext, PromptResponse, WorkflowRouteHandler } from '@flue/runtime';
import orchestratorAgent from '../agents/orchestrator.js';
import { normalizeWebApiMessage, type WebApiMessageInput } from '../connectors/web-api.js';

export const route: WorkflowRouteHandler = async (_c, next) => next();

export interface ChatWorkflowPayload extends WebApiMessageInput {
  session?: string;
}

export interface ChatWorkflowResponse {
  text: string;
  model: PromptResponse['model'];
  usage: PromptResponse['usage'];
  event: ReturnType<typeof normalizeWebApiMessage>;
}

export async function run({
  init,
  payload,
}: FlueContext<ChatWorkflowPayload>): Promise<ChatWorkflowResponse> {
  const event = normalizeWebApiMessage(payload);
  const harness = await init(orchestratorAgent, { name: 'gorombo-orchestrator' });
  const session = await harness.session(payload.session ?? event.conversation.id);
  const response = await session.prompt(createChatPrompt(event));

  return {
    text: response.text,
    model: response.model,
    usage: response.usage,
    event,
  };
}

export function createChatPrompt(event: ReturnType<typeof normalizeWebApiMessage>): string {
  return `
You are handling a normalized GOROMBO chat event.

Before you answer:
1. Use the load_protocols tool for this event.
2. Use either retrieve_context or retrieve_memory if context would help.
3. If a provider is still a placeholder, say that plainly and continue with the best available answer.

Event:
${JSON.stringify(event, null, 2)}

Answer the user message naturally and keep the response concise.
`;
}
