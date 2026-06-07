import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { createDefaultOrchestrator } from './orchestrator/orchestrator.js';
import { receiveNormalizedChatEvent } from './gateway/secure-web-api.js';

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

app.post('/api/chat/events', async (c) => {
  const env = c.env as { API_SECRET?: string };
  const response = await receiveNormalizedChatEvent(await c.req.json(), {
    apiSecret: env.API_SECRET,
    requestSecret: c.req.header('x-api-secret') ?? null,
    orchestrator: createDefaultOrchestrator(),
  });

  return c.json(response, 202);
});

app.route('/', flue());

export default app;
