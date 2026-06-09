import { HTTPException } from 'hono/http-exception';
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
  const apiSecret = readSecret(options.apiSecret);

  if (!apiSecret) {
    throw new HTTPException(503, { message: 'API secret is not configured' });
  }

  if (readSecret(options.requestSecret) !== apiSecret) {
    throw new HTTPException(401, { message: 'Unauthorized' });
  }

  const event = normalizeWebApiMessage(input);
  return options.orchestrator.handle(event);
}

function readSecret(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
