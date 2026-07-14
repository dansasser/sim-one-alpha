import assert from 'node:assert/strict';
import test from 'node:test';
import type { FlueContext } from '@flue/runtime';
import type { NormalizedMessageEvent } from '../core/types/index.js';
import { createInMemoryCodingApprovalService } from '../engine/workers/coding-worker/approvals/approval-service.js';
import type { GithubAuthService } from '../engine/workers/coding-worker/github/github-auth-service.js';
import { createGithubAuthSessionId } from '../engine/workers/coding-worker/github/github-auth-utils.js';
import {
  run,
  type GithubAuthWorkflowDependencies,
} from '../workflows/github-auth.js';

const event = {
  id: 'event-workflow-1',
  connector: 'web-api',
  kind: 'chat.message',
  text: 'authenticate GitHub',
  receivedAt: '2026-07-11T00:00:00.000Z',
  actor: { id: 'actor-1' },
  conversation: { id: 'conversation-1' },
  context: {},
} as const satisfies NormalizedMessageEvent;

test('GitHub auth workflow rejects unsupported actions before loading trusted state', async () => {
  let eventLookups = 0;
  const dependencies = createDependencies(createFakeAuthService(), {
    resolveEvent: () => {
      eventLookups += 1;
      return event;
    },
  });

  await assert.rejects(
    run(context({ action: 'delete', eventId: event.id } as never), dependencies),
    /Unsupported GitHub auth action/,
  );
  assert.equal(eventLookups, 0);
});

test('GitHub auth workflow rejects absent or mismatched trusted event context', async () => {
  const service = createFakeAuthService();
  await assert.rejects(
    run(context({ action: 'status', eventId: event.id }), createDependencies(service, {
      getTrustedEvent: () => undefined,
    })),
    /current trusted event context/i,
  );
  await assert.rejects(
    run(context({ action: 'status', eventId: event.id }), createDependencies(service, {
      getTrustedEvent: () => ({ ...event, id: 'event-other' }),
    })),
    /current trusted eventId/i,
  );
});

test('GitHub auth workflow status uses the trusted persisted event and worker workspace aliases', async () => {
  let statusCalls = 0;
  let serviceOptions: Parameters<GithubAuthWorkflowDependencies['getAuthService']>[0] | undefined;
  const service = createFakeAuthService();
  service.status = async () => {
    statusCalls += 1;
    return {
      state: 'authenticated',
      profile: 'default',
      hostname: 'github.com',
      credentialSource: 'managed_profile',
      accountLogin: 'octocat',
      gitProtocol: 'https',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      checkedAt: new Date().toISOString(),
    };
  };
  const dependencies = createDependencies(service, {
    getAuthService: async (options) => {
      serviceOptions = options;
      return service;
    },
  });

  const result = await run(context(
    { action: 'status', eventId: event.id },
    { GOROMBO_CODING_WORKSPACE_ROOT: 'custom-worker-root' },
  ), dependencies) as Record<string, unknown>;

  assert.equal(statusCalls, 1);
  assert.equal(result.state, 'authenticated');
  assert.equal(result.expiresAt, undefined);
  assert.match(serviceOptions?.workspaceRoot ?? '', /custom-worker-root$/);
});

test('GitHub auth workflow checks managed status before approval or browser login', async () => {
  let startCalls = 0;
  const service = createFakeAuthService();
  service.status = async () => ({
    state: 'authenticated',
    profile: 'default',
    hostname: 'github.com',
    credentialSource: 'managed_profile',
    accountLogin: 'octocat',
    gitProtocol: 'https',
    checkedAt: new Date().toISOString(),
  });
  service.start = async () => {
    startCalls += 1;
    throw new Error('browser login must not start');
  };

  const result = await run(
    context({ action: 'start', eventId: event.id }),
    createDependencies(service),
  ) as Record<string, unknown>;

  assert.equal(result.state, 'authenticated');
  assert.equal(startCalls, 0);
});

test('GitHub auth workflow starts the exact session id carried by its approved request', async () => {
  let startedSessionId: string | undefined;
  let approvedSessionId: string | undefined;
  const service = createFakeAuthService();
  service.start = async (input) => {
    startedSessionId = input.authSessionId;
    return {
      state: 'authorization_pending',
      profile: 'default',
      hostname: 'github.com',
      credentialSource: 'managed_profile',
      authSessionId: input.authSessionId,
      checkedAt: new Date().toISOString(),
    };
  };
  const dependencies = createDependencies(service, {
    evaluateApproval: async (_options, input) => {
      approvedSessionId = String(input.metadata?.authSessionId);
      return {
        request: {
          id: 'approval-1',
          dedupeKey: 'approval-dedupe-1',
          taskId: event.id,
          actionType: 'github.auth.login',
          summary: input.summary,
          reason: input.reason,
          risk: input.risk,
          createdAt: new Date().toISOString(),
          metadata: input.metadata,
        },
        evaluation: {
          allowed: true,
          requiresApproval: true,
          reason: 'approved in test',
          status: 'approved',
        },
      };
    },
  });

  const result = await run(context({ action: 'start', eventId: event.id }), dependencies) as Record<string, unknown>;
  const expectedSessionId = createGithubAuthSessionId(event.id, 'default');

  assert.equal(approvedSessionId, expectedSessionId);
  assert.equal(startedSessionId, expectedSessionId);
  assert.equal(result.authSessionId, expectedSessionId);
});

function context(
  payload: { action: 'status' | 'start'; eventId: string },
  env: Record<string, unknown> = {},
): FlueContext<{ action: 'status' | 'start'; eventId: string }> {
  return { payload, env } as FlueContext<{ action: 'status' | 'start'; eventId: string }>;
}

function createDependencies(
  service: GithubAuthService,
  overrides: Partial<GithubAuthWorkflowDependencies> = {},
): GithubAuthWorkflowDependencies {
  return {
    getTrustedEvent: () => event,
    resolveEvent: (eventId) => eventId === event.id ? event : undefined,
    getAuthService: async () => service,
    createApprovalService: () => createInMemoryCodingApprovalService(),
    evaluateApproval: async () => { throw new Error('approval evaluation was not expected'); },
    getChallengeRelay: () => ({
      deliver: () => undefined,
      consume: () => undefined,
      subscribe: () => () => undefined,
    }),
    ...overrides,
  };
}

function createFakeAuthService(): GithubAuthService {
  return {
    status: async () => ({
      state: 'unauthenticated',
      profile: 'default',
      hostname: 'github.com',
      credentialSource: 'none',
      checkedAt: new Date().toISOString(),
    }),
    start: async () => ({
      state: 'authorization_pending',
      profile: 'default',
      hostname: 'github.com',
      credentialSource: 'managed_profile',
      checkedAt: new Date().toISOString(),
    }),
    cancel: async () => ({
      state: 'cancelled',
      profile: 'default',
      hostname: 'github.com',
      credentialSource: 'managed_profile',
      checkedAt: new Date().toISOString(),
    }),
    createGhEnv: async () => ({}),
    createGitCredentialEnv: async () => ({}),
  };
}
