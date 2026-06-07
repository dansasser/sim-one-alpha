import {
  createAgent,
  defineAgentProfile,
  type AgentRouteHandler,
} from '@flue/runtime';
import { configureRuntimeModels } from '../models/index.js';
import { loadProtocolsTool, retrieveContextTool, retrieveMemoryTool } from '../tools/index.js';

export const route: AgentRouteHandler = async (_c, next) => next();

const codingWorker = defineAgentProfile({
  name: 'coding_worker',
  model: false,
  instructions:
    'Placeholder coding worker profile. Do not autonomously edit code yet; future phases add plan, edit, test, debug loop, diff, and approval behavior.',
});

const instructions = `
You are the GOROMBO main orchestrator.

Load protocols before final reasoning, retrieve memory/context when useful, use registry-backed tools, and delegate only to defined workers.
Use the configured model profile from the project model registry. Do not claim protocol, memory, RAG, or search integrations are live beyond the tools that are actually wired.
`;

export default createAgent(({ env }) => {
  const models = configureRuntimeModels(env);

  return {
    model: models.defaultAgentModel,
    instructions,
    tools: [loadProtocolsTool, retrieveMemoryTool, retrieveContextTool],
    subagents: [codingWorker],
  };
});
