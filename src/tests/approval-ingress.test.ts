import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import app from '../app.js';
import { createApprovalEventBridge } from '../ingress/approval-event-bridge.js';
import { createApprovalIngress, createFileApprovalBindingStore } from '../ingress/approval-ingress.js';
import { createCodingWorkerEvent } from '../workers/coding-worker/events/coding-worker-events.js';
import { createInMemoryCodingApprovalService } from '../workers/coding-worker/approvals/approval-service.js';
import { InMemoryCodingApprovalStore } from '../workers/coding-worker/approvals/approval-store.js';
import type { CodingApprovalRecord } from '../workers/coding-worker/approvals/approval-types.js';

describe('approval ingress', () => {
  function makeIngress() {
    const approvalService = createInMemoryCodingApprovalService(new InMemoryCodingApprovalStore());
    const ingress = createApprovalIngress({ approvalService });
    return { approvalService, ingress };
  }

  it('lists pending approvals filtered by task id', async () => {
    const { approvalService, ingress } = makeIngress();
    const request = await approvalService.createRequest({
      taskId: 'task-a',
      actionType: 'file.edit',
      summary: 'Edit A',
      reason: 'Reason A',
      risk: 'low',
    });
    await ingress.bindApprovalRequest({
      requestId: request.id,
      connector: 'telegram',
      actorId: 'actor-1',
      conversationId: 'conv-1',
      createdAt: new Date().toISOString(),
    });

    const taskA = await ingress.listPendingApprovals({ taskId: 'task-a' });
    assert.equal(taskA.length, 1);
    assert.equal(taskA[0].request.taskId, 'task-a');

    const taskB = await ingress.listPendingApprovals({ taskId: 'task-b' });
    assert.equal(taskB.length, 0);
  });

  it('filters pending approvals by connector binding', async () => {
    const { approvalService, ingress } = makeIngress();
    const requestA = await approvalService.createRequest({
      taskId: 'task-shared',
      actionType: 'file.edit',
      summary: 'Edit A',
      reason: 'Reason A',
      risk: 'low',
    });
    const requestB = await approvalService.createRequest({
      taskId: 'task-shared',
      actionType: 'shell.execute',
      summary: 'Run B',
      reason: 'Reason B',
      risk: 'high',
    });

    await ingress.bindApprovalRequest({
      requestId: requestA.id,
      connector: 'telegram',
      createdAt: new Date().toISOString(),
    });
    await ingress.bindApprovalRequest({
      requestId: requestB.id,
      connector: 'cli',
      createdAt: new Date().toISOString(),
    });

    const telegramPending = await ingress.listPendingApprovals({ connector: 'telegram' });
    assert.equal(telegramPending.length, 1);
    assert.equal(telegramPending[0].request.id, requestA.id);

    const cliPending = await ingress.listPendingApprovals({ connector: 'cli' });
    assert.equal(cliPending.length, 1);
    assert.equal(cliPending[0].request.id, requestB.id);
  });

  it('filters pending approvals by actor and conversation', async () => {
    const { approvalService, ingress } = makeIngress();
    const request = await approvalService.createRequest({
      taskId: 'task-shared',
      actionType: 'file.edit',
      summary: 'Edit',
      reason: 'Reason',
      risk: 'low',
    });

    await ingress.bindApprovalRequest({
      requestId: request.id,
      connector: 'telegram',
      actorId: 'actor-1',
      conversationId: 'conv-1',
      createdAt: new Date().toISOString(),
    });

    const found = await ingress.listPendingApprovals({
      connector: 'telegram',
      actorId: 'actor-1',
      conversationId: 'conv-1',
    });
    assert.equal(found.length, 1);

    const notFound = await ingress.listPendingApprovals({
      connector: 'telegram',
      actorId: 'actor-2',
      conversationId: 'conv-1',
    });
    assert.equal(notFound.length, 0);
  });

  it('returns a single approval request by id', async () => {
    const { approvalService, ingress } = makeIngress();
    const request = await approvalService.createRequest({
      taskId: 'task-1',
      actionType: 'file.edit',
      summary: 'Edit',
      reason: 'Reason',
      risk: 'low',
    });

    const found = await ingress.getApprovalRequest(request.id);
    assert.ok(found);
    assert.equal(found.request.id, request.id);

    const missing = await ingress.getApprovalRequest('missing-id');
    assert.equal(missing, undefined);
  });

  it('records an approval decision with a trusted principal', async () => {
    const { approvalService, ingress } = makeIngress();
    const request = await approvalService.createRequest({
      taskId: 'task-1',
      actionType: 'file.edit',
      summary: 'Edit',
      reason: 'Reason',
      risk: 'low',
    });

    const decision = await ingress.recordApprovalDecision({
      requestId: request.id,
      approved: true,
      decidedBy: 'human-1',
      reason: 'Looks good.',
      principal: { id: 'human-1', roles: ['operator'] },
    });

    assert.equal(decision.approved, true);
    assert.equal(decision.decidedBy, 'human-1');

    const record = await ingress.getApprovalRequest(request.id);
    assert.equal(record?.status, 'approved');
    assert.equal(record?.decision?.approved, true);
  });

  it('records a denial decision', async () => {
    const { approvalService, ingress } = makeIngress();
    const request = await approvalService.createRequest({
      taskId: 'task-1',
      actionType: 'file.edit',
      summary: 'Edit',
      reason: 'Reason',
      risk: 'low',
    });

    const decision = await ingress.recordApprovalDecision({
      requestId: request.id,
      approved: false,
      decidedBy: 'human-1',
      reason: 'Too risky.',
      principal: { id: 'human-1', roles: ['admin'] },
    });

    assert.equal(decision.approved, false);

    const record = await ingress.getApprovalRequest(request.id);
    assert.equal(record?.status, 'denied');
  });

  it('binds a request and lists bindings', async () => {
    const { approvalService, ingress } = makeIngress();
    const request = await approvalService.createRequest({
      taskId: 'task-1',
      actionType: 'file.edit',
      summary: 'Edit',
      reason: 'Reason',
      risk: 'low',
    });

    const binding = await ingress.bindApprovalRequest({
      requestId: request.id,
      connector: 'telegram',
      actorId: 'actor-1',
      conversationId: 'conv-1',
      createdAt: new Date().toISOString(),
    });

    assert.equal(binding.requestId, request.id);
    assert.equal(binding.connector, 'telegram');

    const bindings = await ingress.listBindings({ connector: 'telegram' });
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].requestId, request.id);
  });

  it('upserts bindings for the same request id', async () => {
    const { approvalService, ingress } = makeIngress();
    const request = await approvalService.createRequest({
      taskId: 'task-1',
      actionType: 'file.edit',
      summary: 'Edit',
      reason: 'Reason',
      risk: 'low',
    });

    await ingress.bindApprovalRequest({
      requestId: request.id,
      connector: 'telegram',
      createdAt: new Date().toISOString(),
    });
    await ingress.bindApprovalRequest({
      requestId: request.id,
      connector: 'cli',
      createdAt: new Date().toISOString(),
    });

    const bindings = await ingress.listBindings({});
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].connector, 'cli');
  });

  it('uses a file-backed binding store that shares data across instances', async () => {
    const approvalRoot = mkdtempSync(join(tmpdir(), 'gorombo-approval-ingress-'));
    try {
      const { createSharedCodingApprovalService } = await import('../approvals/shared-approval-service.js');

      const service = createSharedCodingApprovalService({ GOROMBO_APPROVAL_ROOT: approvalRoot });
      const ingressA = createApprovalIngress({
        approvalService: service,
        bindingStore: createFileApprovalBindingStore(approvalRoot),
      });

      const request = await service.createRequest({
        taskId: 'task-1',
        actionType: 'file.edit',
        summary: 'Edit',
        reason: 'Reason',
        risk: 'low',
      });
      await ingressA.bindApprovalRequest({
        requestId: request.id,
        connector: 'telegram',
        conversationId: 'conv-1',
        createdAt: new Date().toISOString(),
      });

      const ingressB = createApprovalIngress({
        approvalService: service,
        bindingStore: createFileApprovalBindingStore(approvalRoot),
      });
      const pending = await ingressB.listPendingApprovals({ connector: 'telegram', conversationId: 'conv-1' });
      assert.equal(pending.length, 1);
      assert.equal(pending[0].request.id, request.id);
    } finally {
      rmSync(approvalRoot, { recursive: true, force: true });
    }
  });
});

describe('approval event bridge', () => {
  function makeIngress() {
    const approvalService = createInMemoryCodingApprovalService(new InMemoryCodingApprovalStore());
    const ingress = createApprovalIngress({ approvalService });
    return { approvalService, ingress };
  }

  it('binds an existing request when evidence contains the request id', async () => {
    const { approvalService, ingress } = makeIngress();
    const request = await approvalService.createRequest({
      taskId: 'task-1',
      actionType: 'file.edit',
      summary: 'Edit',
      reason: 'Reason',
      risk: 'low',
    });

    const bridge = createApprovalEventBridge(ingress, {
      connector: 'telegram',
      actorId: 'actor-1',
      conversationId: 'conv-1',
    });

    await bridge(
      createCodingWorkerEvent({
        type: 'coding.approval.requested',
        taskId: 'task-1',
        action: 'file.edit',
        summary: 'Pending file edits require approval.',
        risk: 'low',
        evidence: [request.id],
      }),
    );

    const pending = await ingress.listPendingApprovals({ connector: 'telegram', conversationId: 'conv-1' });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].request.id, request.id);
  });

  it('creates a request when evidence is missing', async () => {
    const { ingress } = makeIngress();
    const bridge = createApprovalEventBridge(ingress, {
      connector: 'telegram',
      conversationId: 'conv-1',
    });

    await bridge(
      createCodingWorkerEvent({
        type: 'coding.approval.requested',
        taskId: 'task-2',
        action: 'file.edit',
        summary: 'Pending file edits require approval.',
        risk: 'low',
      }),
    );

    const pending = await ingress.listPendingApprovals({ connector: 'telegram', conversationId: 'conv-1' });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].request.taskId, 'task-2');
    assert.equal(pending[0].request.actionType, 'file.edit');
  });

  it('binds a github approval requested event', async () => {
    const { approvalService, ingress } = makeIngress();
    const request = await approvalService.createRequest({
      taskId: 'task-3',
      actionType: 'github.pr.create',
      summary: 'Create PR',
      reason: 'Reason',
      risk: 'medium',
    });

    const bridge = createApprovalEventBridge(ingress, {
      connector: 'telegram',
      actorId: 'actor-1',
      conversationId: 'conv-1',
    });

    await bridge(
      createCodingWorkerEvent({
        type: 'coding.github.approval_requested',
        taskId: 'task-3',
        action: 'github.pr.create',
        summary: 'Create PR approval.',
        evidence: [request.id],
      }),
    );

    const pending = await ingress.listPendingApprovals({ connector: 'telegram' });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].request.id, request.id);
  });

  it('ignores non-approval events', async () => {
    const { ingress } = makeIngress();
    const bridge = createApprovalEventBridge(ingress, { connector: 'telegram' });

    await bridge(
      createCodingWorkerEvent({
        type: 'coding.implementer.completed',
        taskId: 'task-1',
        summary: 'Done',
      }),
    );

    const bindings = await ingress.listBindings({});
    assert.equal(bindings.length, 0);
  });
});

describe('approval HTTP routes', () => {
  async function withApprovalEnv(fn: (approvalRoot: string) => Promise<void>): Promise<void> {
    const previousApiSecret = process.env.API_SECRET;
    const previousApprovalRoot = process.env.GOROMBO_APPROVAL_ROOT;
    const approvalRoot = mkdtempSync(join(tmpdir(), 'gorombo-approval-http-'));

    try {
      process.env.API_SECRET = 'test-approval-secret';
      process.env.GOROMBO_APPROVAL_ROOT = approvalRoot;
      await fn(approvalRoot);
    } finally {
      if (previousApiSecret === undefined) {
        delete process.env.API_SECRET;
      } else {
        process.env.API_SECRET = previousApiSecret;
      }
      if (previousApprovalRoot === undefined) {
        delete process.env.GOROMBO_APPROVAL_ROOT;
      } else {
        process.env.GOROMBO_APPROVAL_ROOT = previousApprovalRoot;
      }
      rmSync(approvalRoot, { recursive: true, force: true });
    }
  }

  it('GET /api/approvals/pending returns pending approvals', async () => {
    await withApprovalEnv(async (approvalRoot) => {
      const { createSharedCodingApprovalService } = await import('../approvals/shared-approval-service.js');
      const { createApprovalIngress, createFileApprovalBindingStore } = await import('../ingress/approval-ingress.js');
      const service = createSharedCodingApprovalService({ GOROMBO_APPROVAL_ROOT: approvalRoot });
      const ingress = createApprovalIngress({
        approvalService: service,
        bindingStore: createFileApprovalBindingStore(approvalRoot),
      });
      const request = await service.createRequest({
        taskId: 'http-task',
        actionType: 'file.edit',
        summary: 'Edit',
        reason: 'Reason',
        risk: 'low',
      });
      await ingress.bindApprovalRequest({
        requestId: request.id,
        connector: 'telegram',
        conversationId: 'conv-1',
        createdAt: new Date().toISOString(),
      });

      const response = await app.request('/api/approvals/pending?connector=telegram&conversationId=conv-1', {
        headers: { 'x-api-secret': 'test-approval-secret' },
      });

      assert.equal(response.status, 200);
      const body = (await response.json()) as Array<{ request: { id: string } }>;
      assert.equal(body.length, 1);
      assert.equal(body[0].request.id, request.id);
    });
  });

  it('GET /api/approvals/:requestId returns one approval', async () => {
    await withApprovalEnv(async (approvalRoot) => {
      const { createSharedCodingApprovalService } = await import('../approvals/shared-approval-service.js');
      const service = createSharedCodingApprovalService({ GOROMBO_APPROVAL_ROOT: approvalRoot });
      const request = await service.createRequest({
        taskId: 'http-task',
        actionType: 'file.edit',
        summary: 'Edit',
        reason: 'Reason',
        risk: 'low',
      });

      const response = await app.request(`/api/approvals/${encodeURIComponent(request.id)}`, {
        headers: { 'x-api-secret': 'test-approval-secret' },
      });

      assert.equal(response.status, 200);
      const body = (await response.json()) as { request: { id: string } };
      assert.equal(body.request.id, request.id);
    });
  });

  it('POST /api/approvals/:requestId/decision records a decision', async () => {
    await withApprovalEnv(async (approvalRoot) => {
      const { createSharedCodingApprovalService } = await import('../approvals/shared-approval-service.js');
      const service = createSharedCodingApprovalService({ GOROMBO_APPROVAL_ROOT: approvalRoot });
      const request = await service.createRequest({
        taskId: 'http-task',
        actionType: 'file.edit',
        summary: 'Edit',
        reason: 'Reason',
        risk: 'low',
      });

      const response = await app.request(`/api/approvals/${encodeURIComponent(request.id)}/decision`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-secret': 'test-approval-secret',
        },
        body: JSON.stringify({ approved: true, decidedBy: 'operator-1', reason: 'Looks good.' }),
      });

      assert.equal(response.status, 200);
      const body = (await response.json()) as { approved: boolean; decidedBy: string };
      assert.equal(body.approved, true);
      assert.equal(body.decidedBy, 'operator-1');

      const record = await service.getRecord(request.id);
      assert.equal(record?.status, 'approved');
    });
  });

  it('GET /api/approvals/bindings/pending returns bindings', async () => {
    await withApprovalEnv(async (approvalRoot) => {
      const { createSharedCodingApprovalService } = await import('../approvals/shared-approval-service.js');
      const { createApprovalIngress, createFileApprovalBindingStore } = await import('../ingress/approval-ingress.js');
      const service = createSharedCodingApprovalService({ GOROMBO_APPROVAL_ROOT: approvalRoot });
      const ingress = createApprovalIngress({
        approvalService: service,
        bindingStore: createFileApprovalBindingStore(approvalRoot),
      });
      const request = await service.createRequest({
        taskId: 'http-task',
        actionType: 'file.edit',
        summary: 'Edit',
        reason: 'Reason',
        risk: 'low',
      });
      await ingress.bindApprovalRequest({
        requestId: request.id,
        connector: 'telegram',
        conversationId: 'conv-1',
        createdAt: new Date().toISOString(),
      });

      const response = await app.request('/api/approvals/bindings/pending?connector=telegram', {
        headers: { 'x-api-secret': 'test-approval-secret' },
      });

      assert.equal(response.status, 200);
      const body = (await response.json()) as Array<{ requestId: string; connector: string }>;
      assert.equal(body.length, 1);
      assert.equal(body[0].requestId, request.id);
      assert.equal(body[0].connector, 'telegram');
    });
  });

  it('approval routes require api secret', async () => {
    await withApprovalEnv(async () => {
      const response = await app.request('/api/approvals/pending');
      assert.equal(response.status, 401);
    });
  });
});

describe('approval ingress end-to-end', () => {
  it('bridges a coding worker approval event to HTTP decision', async () => {
    const previousApiSecret = process.env.API_SECRET;
    const previousApprovalRoot = process.env.GOROMBO_APPROVAL_ROOT;
    const approvalRoot = mkdtempSync(join(tmpdir(), 'gorombo-approval-e2e-'));

    try {
      process.env.API_SECRET = 'test-approval-secret';
      process.env.GOROMBO_APPROVAL_ROOT = approvalRoot;

      const { createSharedCodingApprovalService } = await import('../approvals/shared-approval-service.js');
      const { createApprovalIngress, createFileApprovalBindingStore } = await import('../ingress/approval-ingress.js');
      const { createApprovalEventBridge } = await import('../ingress/approval-event-bridge.js');
      const { createCodingWorkerEvent } = await import('../workers/coding-worker/events/coding-worker-events.js');

      const service = createSharedCodingApprovalService({ GOROMBO_APPROVAL_ROOT: approvalRoot });
      const ingress = createApprovalIngress({
        approvalService: service,
        bindingStore: createFileApprovalBindingStore(approvalRoot),
      });
      const bridge = createApprovalEventBridge(ingress, {
        connector: 'telegram',
        conversationId: '123',
      });

      await bridge(
        createCodingWorkerEvent({
          type: 'coding.approval.requested',
          taskId: 'e2e-task',
          action: 'file.edit',
          summary: 'Edit file.txt',
          risk: 'low',
        }),
      );

      const pendingResponse = await app.request('/api/approvals/pending?connector=telegram&conversationId=123', {
        headers: { 'x-api-secret': 'test-approval-secret' },
      });
      assert.equal(pendingResponse.status, 200);
      const pending = (await pendingResponse.json()) as CodingApprovalRecord[];
      assert.equal(pending.length, 1);
      const requestId = pending[0].request.id;

      const decisionResponse = await app.request(`/api/approvals/${encodeURIComponent(requestId)}/decision`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-secret': 'test-approval-secret',
        },
        body: JSON.stringify({ approved: true, decidedBy: 'operator-1' }),
      });
      assert.equal(decisionResponse.status, 200);

      const evaluation = await service.evaluateRequest(pending[0].request);
      assert.equal(evaluation.allowed, true);
      assert.equal(evaluation.status, 'approved');
    } finally {
      if (previousApiSecret === undefined) {
        delete process.env.API_SECRET;
      } else {
        process.env.API_SECRET = previousApiSecret;
      }
      if (previousApprovalRoot === undefined) {
        delete process.env.GOROMBO_APPROVAL_ROOT;
      } else {
        process.env.GOROMBO_APPROVAL_ROOT = previousApprovalRoot;
      }
      rmSync(approvalRoot, { recursive: true, force: true });
    }
  });
});
