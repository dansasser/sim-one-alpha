import { createAgent, defineAgentProfile, type AgentRouteHandler } from '@flue/runtime';
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
This Phase 1 foundation contains placeholder providers; do not claim real external integrations are active unless a concrete provider is configured.
`;

export default createAgent(({ env }) => ({
  model: typeof env.GOROMBO_MODEL === 'string' ? env.GOROMBO_MODEL : false,
  instructions,
  tools: [loadProtocolsTool, retrieveMemoryTool, retrieveContextTool],
  subagents: [codingWorker],
}));

