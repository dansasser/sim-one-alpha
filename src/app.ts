import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';
import './core/models/runtime.js';
import './engine/schedules/boot.js';
import { requireApiSecret } from './api/middleware/api-secret.js';
import { registerChatEventRoutes } from './api/routes/chat-events.js';
import { registerChatSessionRoutes } from './api/routes/chat-sessions.js';
import { registerApprovalRoutes } from './api/routes/approval-routes.js';
import { registerKnowledgeRoutes } from './api/routes/knowledge.js';
import { registerSchedulesRoutes } from './api/routes/schedules.js';
import { registerTelemetryRoutes } from './api/routes/telemetry.js';
import { registerTelegramAdminRoutes } from './api/routes/telegram-admin.js';
import { registerFlueTelemetryObserver } from './core/telemetry/flue-telemetry.js';

registerFlueTelemetryObserver();

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

app.use('/agents/*', requireApiSecret);
app.use('/workflows/*', requireApiSecret);
app.use('/runs/*', requireApiSecret);
app.use('/api/schedules/*', requireApiSecret);
registerChatEventRoutes(app);
registerChatSessionRoutes(app);
registerKnowledgeRoutes(app);
registerSchedulesRoutes(app);
registerTelemetryRoutes(app);
registerApprovalRoutes(app);
registerTelegramAdminRoutes(app);
app.route('/', flue());

export default app;
