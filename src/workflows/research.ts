import type { FlueContext, PromptResponse, WorkflowRouteHandler } from '@flue/runtime';
import researcherAgent from '../agents/researcher.js';
import type { WebFetchMode } from './retrieval.js';

export const route: WorkflowRouteHandler = async (_c, next) => next();

const researcherHarnessName = 'gorombo-researcher';

export interface ResearchWorkflowPayload {
  text: string;
  actorId?: string;
  conversationId?: string;
  session?: string;
  maxContextTokens?: number;
  webFetch?: WebFetchMode;
  fetchTopK?: number;
}

export interface ResearchWorkflowResponse {
  text: string;
  model: PromptResponse['model'];
  usage: PromptResponse['usage'];
}

export async function run({
  init,
  payload,
}: FlueContext<ResearchWorkflowPayload>): Promise<ResearchWorkflowResponse> {
  const harness = await init(researcherAgent, { name: researcherHarnessName });
  const session = await harness.session(payload.session ?? payload.conversationId ?? 'research');
  const response = await session.prompt(createResearchPrompt(payload));

  return {
    text: response.text,
    model: response.model,
    usage: response.usage,
  };
}

export function createResearchPrompt(payload: ResearchWorkflowPayload): string {
  const maxContextTokens = payload.maxContextTokens ?? 4_000;
  const webFetch = payload.webFetch ?? 'auto';
  const fetchTopK = payload.fetchTopK ?? 1;

  return `
You are running the GOROMBO research workflow.

Use retrieve_context for source-backed research before answering.
Call retrieve_context with maxContextTokens: ${maxContextTokens}, webFetch: "${webFetch}", and fetchTopK: ${fetchTopK}.
Compare sources before writing the final findings.
Preserve source URLs from retrieved context metadata when available.
If metadata.providerFailures reports a failed source, include that limitation in the findings.
Return concise findings that the main orchestrator can use directly.

Research request:
${JSON.stringify(
  {
    text: payload.text,
    actorId: payload.actorId ?? 'research-user',
    conversationId: payload.conversationId ?? payload.session ?? 'research',
  },
  null,
  2,
)}
`;
}
