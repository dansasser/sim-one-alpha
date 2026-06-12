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
export { directAgentHarnessName, directAgentSessionName } from './direct-agent-session.js';

export interface DurableOrchestratorSessionInput {
  sessionId: string;
  env: Record<string, unknown>;
  payload?: unknown;
  allowFullInternetAccess?: boolean;
}

export type DurableOrchestratorSessionOpener = (
  input: DurableOrchestratorSessionInput,
) => Promise<FlueSession>;

export const openDurableOrchestratorSession: DurableOrchestratorSessionOpener = async ({
  sessionId,
  env,
  payload = {},
  allowFullInternetAccess = false,
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
          new Bash(
            allowFullInternetAccess
              ? {
                  fs: new InMemoryFs(),
                  network: {
                    dangerouslyAllowFullInternetAccess: true,
                  },
                }
              : {
                  fs: new InMemoryFs(),
                },
          ),
      ),
    defaultStore: executionStore.sessions,
    submissionStore: executionStore.submissions,
  });

  const harness = await context.initializeCreatedAgent(orchestratorAgent, payload);
  return harness.session();
};
