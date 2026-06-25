import type { Hono } from 'hono';
import { requireApiSecret, runtimeEnvForRequest } from '../../api/middleware/api-secret.js';
import {
  flueTelemetryStore,
  summarizeTelemetryRunFromEvents,
} from '../../core/telemetry/flue-telemetry.js';

/**
 * Registers protected HTTP routes for inspecting sanitized Flue telemetry.
 */
export function registerTelemetryRoutes(app: Hono): void {
  app.get('/api/telemetry/runs/:runId', requireApiSecret, async (c) => {
    const runId = c.req.param('runId');
    const summary =
      flueTelemetryStore.getRunSummary(runId) ??
      await readPersistedRunSummary(app, c.req.raw, c.env as Record<string, unknown> | undefined, runId);

    if (!summary) {
      return c.json({ error: 'Telemetry run not found', runId }, 404);
    }

    return c.json(summary);
  });

  app.get('/api/telemetry/runs', requireApiSecret, (c) => c.json(flueTelemetryStore.snapshot()));
}

async function readPersistedRunSummary(
  app: Hono,
  request: Request,
  env: Record<string, unknown> | undefined,
  runId: string,
) {
  const headers = new Headers(request.headers);
  const response = await app.request(
    `/runs/${encodeURIComponent(runId)}`,
    {
      method: 'GET',
      headers,
    },
    runtimeEnvForRequest(env),
  );

  if (!response.ok) {
    return undefined;
  }

  let body: unknown;
  try {
    body = await response.json() as unknown;
  } catch {
    return undefined;
  }

  if (!Array.isArray(body)) {
    return undefined;
  }

  return summarizeTelemetryRunFromEvents(runId, body);
}
