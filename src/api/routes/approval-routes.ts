import type { Hono } from 'hono';
import { createSharedCodingApprovalService, resolveCodingApprovalRoot } from '../../engine/approvals/shared-approval-service.js';
import { createApprovalIngress, createFileApprovalBindingStore } from '../../api/ingress/approval-ingress.js';
import { requireApiSecret, runtimeEnvForRequest } from '../../api/middleware/api-secret.js';

/**
 * Registers protected HTTP routes for the approval ingress.
 *
 * Routes:
 * - GET  /api/approvals/pending
 * - GET  /api/approvals/:requestId
 * - POST /api/approvals/:requestId/decision
 * - GET  /api/approvals/bindings/pending
 */
export function registerApprovalRoutes(app: Hono): void {
  app.use('/api/approvals/*', requireApiSecret);

  app.get('/api/approvals/pending', async (c) => {
    const ingress = createApprovalIngressFromEnv(runtimeEnvForRequest(c.env as Record<string, unknown> | undefined));
    const pending = await ingress.listPendingApprovals({
      taskId: c.req.query('taskId') ?? undefined,
      actorId: c.req.query('actorId') ?? undefined,
      conversationId: c.req.query('conversationId') ?? undefined,
      connector: c.req.query('connector') ?? undefined,
    });
    return c.json(pending);
  });

  app.get('/api/approvals/:requestId', async (c) => {
    const ingress = createApprovalIngressFromEnv(runtimeEnvForRequest(c.env as Record<string, unknown> | undefined));
    const record = await ingress.getApprovalRequest(c.req.param('requestId'));
    if (!record) {
      return c.json({ error: 'Approval request not found' }, 404);
    }
    return c.json(record);
  });

  app.post('/api/approvals/:requestId/decision', async (c) => {
    const ingress = createApprovalIngressFromEnv(runtimeEnvForRequest(c.env as Record<string, unknown> | undefined));
    const body = (await c.req.json()) as Record<string, unknown>;
    const decidedBy = typeof body.decidedBy === 'string' ? body.decidedBy.trim() : '';
    if (!decidedBy) {
      return c.json({ error: 'decidedBy is required' }, 400);
    }

    try {
      const decision = await ingress.recordApprovalDecision({
        requestId: c.req.param('requestId'),
        approved: body.approved === true,
        decidedBy,
        reason: typeof body.reason === 'string' ? body.reason : undefined,
        principal: { id: decidedBy, roles: ['operator'] },
      });
      return c.json(decision);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to record decision.';
      const status = message.includes('not pending') ? 409 : 400;
      return c.json({ error: message }, status);
    }
  });

  app.get('/api/approvals/bindings/pending', async (c) => {
    const ingress = createApprovalIngressFromEnv(runtimeEnvForRequest(c.env as Record<string, unknown> | undefined));
    const bindings = await ingress.listBindings({
      connector: c.req.query('connector') ?? undefined,
      actorId: c.req.query('actorId') ?? undefined,
      conversationId: c.req.query('conversationId') ?? undefined,
    });
    return c.json(bindings);
  });
}

function createApprovalIngressFromEnv(env: Record<string, unknown>) {
  const approvalService = createSharedCodingApprovalService(env);
  const approvalRoot = resolveCodingApprovalRoot(env);
  return createApprovalIngress({
    approvalService,
    bindingStore: createFileApprovalBindingStore(approvalRoot),
  });
}
