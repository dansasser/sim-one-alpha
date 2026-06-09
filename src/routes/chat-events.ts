import type { Hono } from 'hono';
import { requireApiSecret, runtimeEnvForRequest } from '../middleware/api-secret.js';

export function registerChatEventRoutes(app: Hono): void {
  app.post('/api/chat/events', requireApiSecret, async (c) => {
    const headers = new Headers(c.req.raw.headers);
    headers.set('content-type', 'application/json');

    return app.request(
      '/workflows/chat',
      {
        method: 'POST',
        headers,
        body: JSON.stringify(await c.req.json()),
      },
      runtimeEnvForRequest(c.env as Record<string, unknown> | undefined),
    );
  });
}
