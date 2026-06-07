import type { WorkflowRouteHandler } from '@flue/runtime';
import { normalizeWebApiMessage, type WebApiMessageInput } from '../connectors/web-api.js';
import { createDefaultOrchestrator } from '../orchestrator/orchestrator.js';

export const route: WorkflowRouteHandler = async (_c, next) => next();

export async function run({ payload }: { payload: WebApiMessageInput }) {
  const orchestrator = createDefaultOrchestrator();
  return orchestrator.handle(normalizeWebApiMessage(payload));
}

