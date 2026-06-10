import type { Hono } from 'hono';
import { requireApiSecret } from '../middleware/api-secret.js';
import { flueTelemetryStore } from '../telemetry/flue-telemetry.js';

export function registerTelemetryRoutes(app: Hono): void {
  app.get('/api/telemetry/runs/:runId', requireApiSecret, (c) => {
    const runId = c.req.param('runId');
    const summary = flueTelemetryStore.getRunSummary(runId);

    if (!summary) {
      return c.json({ error: 'Telemetry run not found', runId }, 404);
    }

    return c.json(summary);
  });

  app.get('/api/telemetry/runs', requireApiSecret, (c) => c.json(flueTelemetryStore.snapshot()));
}
