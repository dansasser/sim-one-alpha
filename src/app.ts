import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';
import './models/runtime.js';
import { requireApiSecret } from './middleware/api-secret.js';
import { registerChatEventRoutes } from './routes/chat-events.js';
import { registerApprovalRoutes } from './routes/approval-routes.js';
import { registerKnowledgeRoutes } from './routes/knowledge.js';
import { registerTelemetryRoutes } from './routes/telemetry.js';
import { registerTelegramAdminRoutes } from './routes/telegram-admin.js';
import { registerFlueTelemetryObserver } from './telemetry/flue-telemetry.js';

registerFlueTelemetryObserver();

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

app.use('/agents/*', requireApiSecret);
app.use('/workflows/*', requireApiSecret);
app.use('/runs/*', requireApiSecret);
registerChatEventRoutes(app);
registerKnowledgeRoutes(app);
registerTelemetryRoutes(app);
registerApprovalRoutes(app);
registerTelegramAdminRoutes(app);
app.route('/', flue());

export default app;
