import type { Hono } from 'hono';
import { requireApiSecret, runtimeEnvForRequest } from '../middleware/api-secret.js';
import { listChatSessions } from '../session/session-routing.js';

export function registerChatEventRoutes(app: Hono): void {
  app.get('/api/chat/sessions', requireApiSecret, (c) => {
    const parsedLimit = Number.parseInt(c.req.query('limit') ?? '', 10);
    const limit = Number.isInteger(parsedLimit)
      ? Math.min(100, Math.max(1, parsedLimit))
      : 50;
    return c.json({
      sessions: listChatSessions(limit),
    });
  });

  app.post('/api/chat/events', requireApiSecret, async (c) => {
    const headers = new Headers(c.req.raw.headers);
    headers.set('content-type', 'application/json');
    let payload: unknown;

    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON payload' }, 400);
    }

    return app.request(
      '/workflows/chat',
      {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      },
      runtimeEnvForRequest(c.env as Record<string, unknown> | undefined),
    );
  });
}
