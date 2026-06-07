import { normalizeWebApiMessage, type WebApiMessageInput } from '../connectors/web-api.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import type { OrchestratorResponse } from '../types/index.js';

export interface SecureGatewayOptions {
  apiSecret?: string;
  requestSecret?: string | null;
  orchestrator: Orchestrator;
}

export async function receiveNormalizedChatEvent(
  input: WebApiMessageInput,
  options: SecureGatewayOptions,
): Promise<OrchestratorResponse> {
  if (options.apiSecret && options.requestSecret !== options.apiSecret) {
    throw new Error('Unauthorized');
  }

  const event = normalizeWebApiMessage(input);
  return options.orchestrator.handle(event);
}

