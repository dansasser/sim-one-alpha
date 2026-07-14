import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createInMemoryCodingApprovalService } from '../engine/workers/coding-worker/approvals/approval-service.js';
import { createCodingGithubAuthTools } from '../engine/workers/coding-worker/github/github-auth-tools.js';
import type { GithubAuthService } from '../engine/workers/coding-worker/github/github-auth-service.js';
import type { GithubAuthAudience } from '../engine/workers/coding-worker/github/github-auth-types.js';
import { InMemoryGithubAuthChallengeRelay } from '../api/ingress/github-auth-challenge-relay.js';
import { runWithTrustedMessageEvent } from '../api/ingress/trusted-event-context.js';

const event = {
  id: 'event-auth-1',
  connector: 'web-api',
  kind: 'chat.message',
  text: 'clone a private repo',
  receivedAt: '2026-07-11T00:00:00.000Z',
  actor: { id: 'actor-1' },
  conversation: { id: 'conversation-1' },
  context: {},
} as const;

test('Coding Worker GitHub auth start is approval-gated and privately relays only to the trusted event audience', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'github-auth-tools-'));
  const approvalService = createInMemoryCodingApprovalService();
  const relay = new InMemoryGithubAuthChallengeRelay();
  const challengeExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  let started = 0;
  const authService: GithubAuthService = {
    status: async () => ({
      state: 'unauthenticated',
      profile: 'default',
      hostname: 'github.com',
      credentialSource: 'none',
      checkedAt: '2026-07-11T00:00:00.000Z',
    }),
    start: async ({ audience, deliverChallenge }) => {
      started += 1;
      await deliverChallenge({
        sessionId: 'session-1',
        audience,
        verificationUri: 'https://github.com/login/device',
        userCode: 'WXYZ-1234',
        expiresAt: challengeExpiresAt,
      });
      return {
        state: 'authorization_pending',
        profile: 'default',
        hostname: 'github.com',
        credentialSource: 'managed_profile',
        authSessionId: 'session-1',
        expiresAt: challengeExpiresAt,
        checkedAt: '2026-07-11T00:00:00.000Z',
      };
    },
    cancel: async () => ({
      state: 'cancelled',
      profile: 'default',
      hostname: 'github.com',
      credentialSource: 'managed_profile',
      checkedAt: '2026-07-11T00:00:00.000Z',
    }),
    createGhEnv: async () => ({}),
    createGitCredentialEnv: async () => ({}),
  };

  try {
    const tools = createCodingGithubAuthTools({
      workspaceRoot,
      approvalService,
      authService,
      challengeRelay: relay,
      currentEventId: event.id,
      resolveEvent: (eventId) => eventId === event.id ? event : undefined,
    });
    const start = getTool(tools, 'github_auth_start');

    const blocked = JSON.parse(await start.execute({ eventId: event.id })) as {
      blocked?: boolean;
      request?: { id: string; actionType: string; metadata?: Record<string, unknown> };
    };
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.request?.actionType, 'github.auth.login');
    assert.deepEqual({
      ...blocked.request?.metadata,
      authSessionId: undefined,
    }, {
      actorId: event.actor.id,
      connector: event.connector,
      conversationId: event.conversation.id,
      eventId: event.id,
      hostname: 'github.com',
      profile: 'default',
      scope: 'workflow',
      authSessionId: undefined,
    });
    assert.match(String(blocked.request?.metadata?.authSessionId), /^[a-f0-9]{32}$/);
    assert.equal(started, 0);

    await approvalService.recordDecision({
      requestId: blocked.request!.id,
      approved: true,
      decidedBy: 'operator-1',
      principal: { id: 'operator-1', roles: ['operator'] },
    });

    const startedOutput = JSON.parse(await start.execute({ eventId: event.id })) as Record<string, unknown>;
    assert.equal(startedOutput.state, 'authorization_pending');
    assert.equal(startedOutput.userCode, undefined);
    assert.equal(startedOutput.verificationUri, undefined);
    assert.equal(startedOutput.expiresAt, undefined);
    assert.equal(started, 1);
    assert.equal(relay.consume({
      connector: event.connector,
      actorId: 'other-actor',
      conversationId: event.conversation.id,
      eventId: event.id,
    }), undefined);
    assert.deepEqual(relay.consume({
      connector: event.connector,
      actorId: event.actor.id,
      conversationId: event.conversation.id,
      eventId: event.id,
    }), {
      sessionId: 'session-1',
      verificationUri: 'https://github.com/login/device',
      userCode: 'WXYZ-1234',
      expiresAt: challengeExpiresAt,
    });
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('GitHub auth tools reject a persisted event that is not the current trusted event', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'github-auth-current-event-'));
  const currentEvent = { ...event, id: 'event-current' };
  const unrelatedEvent = {
    ...event,
    id: 'event-unrelated',
    actor: { id: 'actor-2' },
    conversation: { id: 'conversation-2' },
  };
  const authService = createFakeAuthService();

  try {
    const tools = createCodingGithubAuthTools({
      workspaceRoot,
      authService,
      currentEventId: currentEvent.id,
      resolveEvent: (eventId) => {
        if (eventId === currentEvent.id) return currentEvent;
        if (eventId === unrelatedEvent.id) return unrelatedEvent;
        return undefined;
      },
    } as Parameters<typeof createCodingGithubAuthTools>[0] & { currentEventId: string });
    const status = getTool(tools, 'github_auth_status');

    await assert.rejects(
      () => status.execute({ eventId: unrelatedEvent.id }),
      /current trusted event/i,
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('GitHub auth status is bound to the trusted event context', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'github-auth-trusted-context-'));
  let statusCalls = 0;
  const authService = createFakeAuthService();
  authService.status = async () => {
    statusCalls += 1;
    return {
      state: 'unauthenticated',
      profile: 'default',
      hostname: 'github.com',
      credentialSource: 'none',
      checkedAt: new Date().toISOString(),
    };
  };

  try {
    const status = getTool(createCodingGithubAuthTools({ workspaceRoot, authService }), 'github_auth_status');
    const result = await runWithTrustedMessageEvent(event, () => status.execute({ eventId: event.id }));
    assert.equal(JSON.parse(result).state, 'unauthenticated');
    assert.equal(statusCalls, 1);
    await assert.rejects(
      runWithTrustedMessageEvent(event, () => status.execute({ eventId: 'event-unrelated' })),
      /current trusted event/i,
    );
    await assert.rejects(
      status.execute({ eventId: event.id }),
      /trusted event context or event admission/i,
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('GitHub auth tools accept only a matching unexpired event admission outside request-local context', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'github-auth-admission-'));
  const authService = createFakeAuthService();
  const admission = {
    id: 'admission-current',
    eventId: event.id,
    purpose: 'github.auth',
    connector: event.connector,
    actorId: event.actor.id,
    conversationId: event.conversation.id,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
  } as const;

  try {
    const status = getTool(createCodingGithubAuthTools({
      workspaceRoot,
      authService,
      resolveEvent: (eventId) => eventId === event.id ? event : undefined,
      resolveAdmission: (admissionId) => admissionId === admission.id ? admission : undefined,
    }), 'github_auth_status');

    assert.equal(JSON.parse(await status.execute({
      eventId: event.id,
      admissionId: admission.id,
    })).state, 'unauthenticated');
    await assert.rejects(
      status.execute({ eventId: event.id, admissionId: 'admission-unrelated' }),
      /event admission/i,
    );
    await assert.rejects(
      status.execute({ eventId: 'event-unrelated', admissionId: admission.id }),
      /event admission/i,
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('GitHub auth start returns authenticated status without approval or device login', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'github-auth-already-authenticated-'));
  const approvalService = createInMemoryCodingApprovalService();
  let starts = 0;
  const authService = createFakeAuthService({
    state: 'authenticated',
    credentialSource: 'managed_profile',
    accountLogin: 'octocat',
    gitProtocol: 'https',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, () => {
    starts += 1;
  });

  try {
    const tools = createCodingGithubAuthTools({
      workspaceRoot,
      approvalService,
      authService,
      currentEventId: event.id,
      resolveEvent: (eventId) => eventId === event.id ? event : undefined,
    });
    const start = getTool(tools, 'github_auth_start');
    const result = JSON.parse(await start.execute({ eventId: event.id })) as {
      state?: string;
      blocked?: boolean;
    };

    assert.equal(result.state, 'authenticated');
    assert.equal(result.blocked, undefined);
    assert.equal((result as { expiresAt?: string }).expiresAt, undefined);
    assert.equal(starts, 0);
    assert.deepEqual(await approvalService.listRecords(event.id), []);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('a later trusted event can continue an approved GitHub login request', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'github-auth-approved-continuation-'));
  const approvalService = createInMemoryCodingApprovalService();
  const relay = new InMemoryGithubAuthChallengeRelay();
  const firstEvent = { ...event, id: 'event-approval-request' };
  const continuationEvent = { ...event, id: 'event-approval-continuation' };
  const challengeExpiresAt = new Date(Date.now() + 60_000).toISOString();
  let startAudience: GithubAuthAudience | undefined;
  let startSessionId: string | undefined;
  const authService = createFakeAuthService();
  authService.start = async ({ authSessionId, audience, deliverChallenge }) => {
    startAudience = audience;
    startSessionId = authSessionId;
    await deliverChallenge({
      sessionId: authSessionId!,
      audience,
      verificationUri: 'https://github.com/login/device',
      userCode: 'FLOW-0001',
      expiresAt: challengeExpiresAt,
    });
    return {
      state: 'authorization_pending',
      profile: 'default',
      hostname: 'github.com',
      credentialSource: 'managed_profile',
      authSessionId,
      expiresAt: challengeExpiresAt,
      checkedAt: new Date().toISOString(),
    };
  };

  try {
    const requestTool = getTool(createCodingGithubAuthTools({
      workspaceRoot,
      approvalService,
      authService,
      challengeRelay: relay,
      currentEventId: firstEvent.id,
      resolveEvent: (eventId) => eventId === firstEvent.id ? firstEvent : undefined,
    }), 'github_auth_start');
    const blocked = JSON.parse(await requestTool.execute({ eventId: firstEvent.id })) as {
      request: { id: string; metadata?: Record<string, unknown> };
    };
    await approvalService.recordDecision({
      requestId: blocked.request.id,
      approved: true,
      decidedBy: 'operator-1',
      principal: { id: 'operator-1', roles: ['operator'] },
    });

    const continueTool = getTool(createCodingGithubAuthTools({
      workspaceRoot,
      approvalService,
      authService,
      challengeRelay: relay,
      currentEventId: continuationEvent.id,
      resolveEvent: (eventId) => eventId === continuationEvent.id ? continuationEvent : undefined,
    }), 'github_auth_start');
    const continued = JSON.parse(await continueTool.execute({
      eventId: continuationEvent.id,
      approvalRequestId: blocked.request.id,
    })) as { state?: string; blocked?: boolean };

    assert.equal(continued.state, 'authorization_pending');
    assert.equal(continued.blocked, undefined);
    assert.equal(startAudience?.eventId, continuationEvent.id);
    assert.equal(startSessionId, blocked.request.metadata?.authSessionId);
    assert.deepEqual(relay.consume({
      connector: continuationEvent.connector,
      actorId: continuationEvent.actor.id,
      conversationId: continuationEvent.conversation.id,
      eventId: continuationEvent.id,
    }), {
      sessionId: startSessionId,
      verificationUri: 'https://github.com/login/device',
      userCode: 'FLOW-0001',
      expiresAt: challengeExpiresAt,
    });
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

function createFakeAuthService(
  statusOverrides: Partial<Awaited<ReturnType<GithubAuthService['status']>>> = {},
  onStart: () => void = () => {},
): GithubAuthService {
  return {
    status: async () => ({
      state: 'unauthenticated',
      profile: 'default',
      hostname: 'github.com',
      credentialSource: 'none',
      checkedAt: '2026-07-11T00:00:00.000Z',
      ...statusOverrides,
    }),
    start: async () => {
      onStart();
      return {
        state: 'authorization_pending',
        profile: 'default',
        hostname: 'github.com',
        credentialSource: 'managed_profile',
        checkedAt: '2026-07-11T00:00:00.000Z',
      };
    },
    cancel: async () => ({
      state: 'cancelled',
      profile: 'default',
      hostname: 'github.com',
      credentialSource: 'managed_profile',
      checkedAt: '2026-07-11T00:00:00.000Z',
    }),
    createGhEnv: async () => ({}),
    createGitCredentialEnv: async () => ({}),
  };
}

function getTool(tools: unknown[], name: string): {
  execute(args: { eventId: string; admissionId?: string; approvalRequestId?: string }): Promise<string>;
} {
  const tool = (tools as Array<{ name: string; execute: unknown }>).find((candidate) => candidate.name === name);
  assert.ok(tool, `Missing ${name} tool.`);
  return tool as unknown as {
    execute(args: { eventId: string; admissionId?: string; approvalRequestId?: string }): Promise<string>;
  };
}
