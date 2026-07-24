import type { FlueContext } from '@flue/runtime';
import { resolve } from 'node:path';
import * as v from 'valibot';
import { goromboPersistenceRuntime } from '../db.js';
import type { NormalizedMessageEvent } from '../core/types/index.js';
import { createSharedCodingApprovalService } from '../engine/approvals/shared-approval-service.js';
import { evaluateGitApproval } from '../engine/workers/coding-worker/tools/coding-git-tools.js';
import { getGithubAuthService } from '../engine/workers/coding-worker/github/github-auth-runtime.js';
import { getGithubAuthChallengeRelay } from '../api/ingress/github-auth-challenge-relay.js';
import { getTrustedMessageEvent } from '../api/ingress/trusted-event-context.js';
import {
  createGithubAuthSessionId,
  toModelVisibleGithubAuthResult,
} from '../engine/workers/coding-worker/github/github-auth-utils.js';

export interface GithubAuthWorkflowPayload {
  action: 'status' | 'start';
  eventId: string;
}

const GithubAuthWorkflowPayloadSchema = v.object({
  action: v.picklist(['status', 'start']),
  eventId: v.string(),
});

/**
 * A finite internal Flue seam for trusted GitHub auth operations. It never
 * waits for browser completion; the auth runtime owns the retained child. A
 * public route requires a durable event-scoped admission grant first.
 */
export async function run(
  { payload, env }: FlueContext<GithubAuthWorkflowPayload>,
  dependencyOverrides: Partial<GithubAuthWorkflowDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const parsed = v.safeParse(GithubAuthWorkflowPayloadSchema, payload);
  if (!parsed.success) {
    throw new Error(`Unsupported GitHub auth action: ${String((payload as { action?: unknown })?.action)}`);
  }
  const input = parsed.output;
  const trustedEvent = dependencies.getTrustedEvent();
  if (!trustedEvent) {
    throw new Error('GitHub auth workflow requires a current trusted event context.');
  }
  if (trustedEvent.id !== input.eventId) {
    throw new Error('GitHub auth workflow requires the current trusted eventId.');
  }
  const event = dependencies.resolveEvent(input.eventId);
  if (!event) {
    throw new Error('GitHub auth workflow requires a trusted eventId persisted by chat ingress.');
  }
  const workspaceRoot = resolve(
    readEnv(env, 'GOROMBO_WORKSPACE_ROOT') ??
    readEnv(env, 'GOROMBO_CODING_WORKSPACE_ROOT') ??
    readEnv(env, 'GOROMBO_CODING_REPO_PATH') ??
    'src/workspace',
  );
  const authService = await dependencies.getAuthService({
    workspaceRoot,
    authRoot: readEnv(env, 'GOROMBO_GITHUB_AUTH_ROOT'),
    env: {
      GH_TOKEN: readEnv(env, 'GH_TOKEN'),
      GITHUB_TOKEN: readEnv(env, 'GITHUB_TOKEN'),
    },
  });

  switch (input.action) {
    case 'status':
      return toModelVisibleGithubAuthResult(await authService.status());
    case 'start':
      break;
    default:
      throw new Error(`Unsupported GitHub auth action: ${String(input.action)}`);
  }

  const profile = 'default';
  const currentStatus = await authService.status({ profile });
  if (currentStatus.state === 'authenticated') {
    return toModelVisibleGithubAuthResult(currentStatus);
  }
  const authSessionId = createGithubAuthSessionId(event.id, profile);
  const approvalService = dependencies.createApprovalService({
    GOROMBO_APPROVAL_ROOT: readEnv(env, 'GOROMBO_APPROVAL_ROOT'),
  });
  const approval = await dependencies.evaluateApproval({}, {
    approvalService,
    taskId: event.id,
    actionType: 'github.auth.login',
    summary: 'Authorize the Coding Worker managed GitHub profile.',
    reason: 'GitHub device authorization creates persistent managed provider credentials.',
    risk: 'This grants the Coding Worker access to the GitHub account selected in the browser.',
    target: 'github.com',
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    metadata: {
      connector: event.connector,
      actorId: event.actor.id,
      conversationId: event.conversation.id,
      eventId: event.id,
      hostname: 'github.com',
      profile,
      scope: 'workflow',
      authSessionId,
    },
  });
  if (!approval.evaluation.allowed) {
    return { blocked: true, request: approval.request, evaluation: approval.evaluation };
  }
  return toModelVisibleGithubAuthResult(await authService.start({
    profile,
    authSessionId,
    audience: {
      connector: event.connector,
      actorId: event.actor.id,
      conversationId: event.conversation.id,
      eventId: event.id,
    },
    deliverChallenge: (challenge) => dependencies.getChallengeRelay().deliver(challenge),
  }));
}

export interface GithubAuthWorkflowDependencies {
  getTrustedEvent(): NormalizedMessageEvent | undefined;
  resolveEvent(eventId: string): NormalizedMessageEvent | undefined;
  getAuthService: typeof getGithubAuthService;
  createApprovalService: typeof createSharedCodingApprovalService;
  evaluateApproval: typeof evaluateGitApproval;
  getChallengeRelay: typeof getGithubAuthChallengeRelay;
}

const defaultDependencies: GithubAuthWorkflowDependencies = {
  getTrustedEvent: getTrustedMessageEvent,
  resolveEvent: (eventId) =>
    goromboPersistenceRuntime.sessionDatabase.getNormalizedMessageEvent(eventId) ?? undefined,
  getAuthService: getGithubAuthService,
  createApprovalService: createSharedCodingApprovalService,
  evaluateApproval: evaluateGitApproval,
  getChallengeRelay: getGithubAuthChallengeRelay,
};

function readEnv(env: Record<string, unknown>, key: string): string | undefined {
  const value = env[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
