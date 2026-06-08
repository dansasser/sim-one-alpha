import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';
import './models/runtime.js';

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

app.post('/api/chat/events', async (c) => {
  const env = c.env as { API_SECRET?: string };
  const requestSecret = c.req.header('x-api-secret') ?? null;
  if (env.API_SECRET && requestSecret !== env.API_SECRET) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  return app.request(
    '/workflows/chat',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(await c.req.json()),
    },
    c.env,
    c.executionCtx,
  );
});

app.route('/', flue());

export default app;
