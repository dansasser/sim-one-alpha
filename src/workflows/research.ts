import type { FlueContext, PromptResponse, WorkflowRouteHandler } from '@flue/runtime';
import researcherAgent from '../workers/researcher/researcher.js';
import type { ResearchDepth } from './web-research.js';
import type { WebFetchMode } from './retrieval.js';

export const route: WorkflowRouteHandler = async (_c, next) => next();

const researcherHarnessName = 'gorombo-researcher';

export interface ResearchWorkflowPayload {
  text: string;
  actorId?: string;
  conversationId?: string;
  session?: string;
  depth?: ResearchDepth;
  maxContextTokens?: number;
  webFetch?: WebFetchMode;
  fetchTopK?: number;
}

export interface ResearchWorkflowResponse {
  text: string;
  model: PromptResponse['model'];
  usage: PromptResponse['usage'];
}

/**
 * Runs the standalone research workflow by prompting the researcher worker directly.
 */
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

/**
 * Builds the researcher prompt with bounded web-research controls from the workflow payload.
 */
export function createResearchPrompt(payload: ResearchWorkflowPayload): string {
  const depth = payload.depth ?? 'standard';
  const webResearchControls = [`depth: "${depth}"`];

  if (payload.maxContextTokens !== undefined) {
    webResearchControls.push(`maxContextTokens: ${payload.maxContextTokens}`);
  }

  if (payload.webFetch !== undefined) {
    webResearchControls.push(`webFetch: "${payload.webFetch}"`);
  }

  if (payload.fetchTopK !== undefined) {
    webResearchControls.push(`maxFetches: ${payload.fetchTopK}`);
  }

  return `
You are running the GOROMBO research workflow.

Use web_research for source-backed research before answering.
Call web_research with ${webResearchControls.join(', ')}, and enough maxQueries for the task complexity.
When a budget or fetch option is not listed, omit it so web_research applies the selected depth defaults.
Compare sources before writing the final findings.
Preserve source URLs from retrieved context metadata when available.
If providerFailures reports a failed source, include that limitation in the findings.
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
