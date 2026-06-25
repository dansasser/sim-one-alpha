import type { FlueSession } from '@flue/runtime';
import {
  Bash,
  InMemoryFs,
  bashFactoryToSessionEnv,
  createFlueContext,
  resolveModel,
} from '@flue/runtime/internal';
import orchestratorAgent from '../../engine/agents/orchestrator.js';
import { goromboPersistenceRuntime } from '../../core/db.js';
export { directAgentHarnessName, directAgentSessionName } from '../../engine/session/direct-agent-session.js';

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
  const stores = await goromboPersistenceRuntime.adapter.connect();
  const context = createFlueContext({
    id: sessionId,
    payload,
    env,
    agentConfig: {
      packagedSkills: {},
      resolveModel,
    },
    createDefaultEnv: async () =>
      bashFactoryToSessionEnv(
        () =>
          new Bash(
            allowFullInternetAccess
              ? {
                  fs: new InMemoryFs(),
                  cwd: 'src',
                  network: {
                    dangerouslyAllowFullInternetAccess: true,
                  },
                }
              : {
                  fs: new InMemoryFs(),
                  cwd: 'src',
                },
          ),
      ),
    defaultStore: stores.executionStore.sessions,
    submissionStore: stores.executionStore.submissions,
  });

  const harness = await context.initializeCreatedAgent(orchestratorAgent, payload);
  return harness.session();
};
