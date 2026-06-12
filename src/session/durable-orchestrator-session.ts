import type { FlueSession } from '@flue/runtime';
import {
  Bash,
  InMemoryFs,
  bashFactoryToSessionEnv,
  createFlueContext,
  resolveModel,
} from '@flue/runtime/internal';
import orchestratorAgent from '../agents/orchestrator.js';
import { goromboPersistenceRuntime } from '../db.js';

export interface DurableOrchestratorSessionInput {
  sessionId: string;
  env: Record<string, unknown>;
  payload?: unknown;
}

export type DurableOrchestratorSessionOpener = (
  input: DurableOrchestratorSessionInput,
) => Promise<FlueSession>;

export const directAgentHarnessName = 'default';
export const directAgentSessionName = 'default';

export const openDurableOrchestratorSession: DurableOrchestratorSessionOpener = async ({
  sessionId,
  env,
  payload = {},
}) => {
  const executionStore = goromboPersistenceRuntime.adapter.connect();
  const context = createFlueContext({
    id: sessionId,
    payload,
    env,
    agentConfig: {
      systemPrompt: '',
      skills: {},
      packagedSkills: {},
      model: undefined,
      resolveModel,
    },
    createDefaultEnv: async () =>
      bashFactoryToSessionEnv(
        () =>
          new Bash({
            fs: new InMemoryFs(),
            network: {
              dangerouslyAllowFullInternetAccess: true,
            },
          }),
      ),
    defaultStore: executionStore.sessions,
    submissionStore: executionStore.submissions,
  });

  const harness = await context.initializeCreatedAgent(orchestratorAgent, payload);
  return harness.session();
};
