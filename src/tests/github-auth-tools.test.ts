import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createInMemoryCodingApprovalService } from '../engine/workers/coding-worker/approvals/approval-service.js';
import { createCodingGithubAuthTools } from '../engine/workers/coding-worker/github/github-auth-tools.js';
import type { GithubAuthService } from '../engine/workers/coding-worker/github/github-auth-service.js';
import { InMemoryGithubAuthChallengeRelay } from '../api/ingress/github-auth-challenge-relay.js';

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
        expiresAt: '2030-01-01T00:15:00.000Z',
      });
      return {
        state: 'authorization_pending',
        profile: 'default',
        hostname: 'github.com',
        credentialSource: 'managed_profile',
        authSessionId: 'session-1',
        expiresAt: '2030-01-01T00:15:00.000Z',
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
      expiresAt: '2030-01-01T00:15:00.000Z',
    });
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

function getTool(tools: unknown[], name: string): {
  execute(args: { eventId: string }): Promise<string>;
} {
  const tool = (tools as Array<{ name: string; execute: unknown }>).find((candidate) => candidate.name === name);
  assert.ok(tool, `Missing ${name} tool.`);
  return tool as unknown as { execute(args: { eventId: string }): Promise<string> };
}
