import type { FlueContext, WorkflowRouteHandler } from '@flue/runtime';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { goromboPersistenceRuntime } from '../db.js';
import { createSharedCodingApprovalService } from '../engine/approvals/shared-approval-service.js';
import { evaluateGitApproval } from '../engine/workers/coding-worker/tools/coding-git-tools.js';
import { getGithubAuthService } from '../engine/workers/coding-worker/github/github-auth-runtime.js';
import { getGithubAuthChallengeRelay } from '../api/ingress/github-auth-challenge-relay.js';

export interface GithubAuthWorkflowPayload {
  action: 'status' | 'start';
  eventId: string;
}

export const route: WorkflowRouteHandler = async (_c, next) => next();

/**
 * A finite admitted Flue seam for operator/UI GitHub auth operations. It never
 * waits for browser completion; the auth runtime owns the retained child.
 */
export async function run({ payload, env }: FlueContext<GithubAuthWorkflowPayload>) {
  const event = goromboPersistenceRuntime.sessionDatabase.getNormalizedMessageEvent(payload.eventId);
  if (!event) {
    throw new Error('GitHub auth workflow requires a trusted eventId persisted by chat ingress.');
  }
  const workspaceRoot = resolve(readEnv(env, 'GOROMBO_WORKSPACE_ROOT') ?? 'src/workspace');
  const authService = await getGithubAuthService({
    workspaceRoot,
    authRoot: readEnv(env, 'GOROMBO_GITHUB_AUTH_ROOT'),
    env: {
      GH_TOKEN: readEnv(env, 'GH_TOKEN'),
      GITHUB_TOKEN: readEnv(env, 'GITHUB_TOKEN'),
    },
  });

  if (payload.action === 'status') {
    return authService.status();
  }

  const profile = 'default';
  const authSessionId = stableSessionId(event.id, profile);
  const approvalService = createSharedCodingApprovalService({
    GOROMBO_APPROVAL_ROOT: readEnv(env, 'GOROMBO_APPROVAL_ROOT'),
  });
  const approval = await evaluateGitApproval({}, {
    approvalService,
    taskId: event.id,
    actionType: 'github.auth.login',
    summary: 'Authorize the Coding Worker managed GitHub profile.',
    reason: 'GitHub device authorization creates persistent managed provider credentials.',
    risk: 'This grants the Coding Worker access to the GitHub account selected in the browser.',
    target: 'github.com',
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
  return authService.start({
    profile,
    authSessionId,
    audience: {
      connector: event.connector,
      actorId: event.actor.id,
      conversationId: event.conversation.id,
      eventId: event.id,
    },
    deliverChallenge: (challenge) => getGithubAuthChallengeRelay().deliver(challenge),
  });
}

function readEnv(env: Record<string, unknown>, key: string): string | undefined {
  const value = env[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stableSessionId(eventId: string, profile: string): string {
  return createHash('sha256').update(`${eventId}\u0000${profile}`).digest('hex').slice(0, 32);
}
