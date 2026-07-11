import { createHash } from 'node:crypto';
import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import { goromboPersistenceRuntime } from '../../../../db.js';
import type { NormalizedMessageEvent } from '../../../../core/types/index.js';
import { getGithubAuthChallengeRelay, type GithubAuthChallengeRelay } from '../../../../api/ingress/github-auth-challenge-relay.js';
import type { CodingApprovalService } from '../approvals/approval-service.js';
import { createInMemoryCodingApprovalService } from '../approvals/approval-service.js';
import { evaluateGitApproval } from '../tools/coding-git-tools.js';
import type { CodingProgressReporter } from '../events/progress-reporter.js';
import {
  type GithubAuthService,
} from './github-auth-service.js';
import { getGithubAuthService } from './github-auth-runtime.js';

export interface CodingGithubAuthToolsOptions {
  workspaceRoot: string;
  authRoot?: string;
  env?: Record<string, string | undefined>;
  approvalService?: CodingApprovalService;
  reporter?: CodingProgressReporter;
  authService?: GithubAuthService;
  challengeRelay?: GithubAuthChallengeRelay;
  resolveEvent?(eventId: string): NormalizedMessageEvent | undefined;
}

export function createCodingGithubAuthTools(options: CodingGithubAuthToolsOptions): ToolDefinition[] {
  const approvalService = options.approvalService ?? createInMemoryCodingApprovalService();
  const relay = options.challengeRelay ?? getGithubAuthChallengeRelay();
  const getService = async () => options.authService ?? getGithubAuthService({
    workspaceRoot: options.workspaceRoot,
    authRoot: options.authRoot,
    env: options.env,
  });
  const resolveEvent = options.resolveEvent ?? resolvePersistedEvent;

  return [
    defineTool({
      name: 'github_auth_status',
      description: 'Check Coding Worker managed GitHub authentication for the trusted chat event. Read-only.',
      parameters: v.object({ eventId: v.string() }),
      execute: async ({ eventId }) => {
        resolveTrustedEvent(resolveEvent, eventId);
        return JSON.stringify(await (await getService()).status(), null, 2);
      },
    }),
    defineTool({
      name: 'github_auth_start',
      description: 'Request approval and start managed HTTPS GitHub browser authorization for the trusted chat event.',
      parameters: v.object({ eventId: v.string() }),
      execute: async ({ eventId }) => {
        const event = resolveTrustedEvent(resolveEvent, eventId);
        const profile = 'default';
        const authSessionId = stableSessionId(event.id, profile);
        const approval = await evaluateGitApproval({ reporter: options.reporter }, {
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
          options.reporter?.emit({
            type: 'coding.github.auth.requested',
            taskId: event.id,
            action: 'github.auth.login',
            status: approval.evaluation.status,
            summary: 'GitHub authorization requires an approved request.',
            evidence: [approval.request.id],
          });
          return JSON.stringify({ blocked: true, request: approval.request, evaluation: approval.evaluation }, null, 2);
        }
        const result = await (await getService()).start({
          profile,
          authSessionId,
          audience: {
            connector: event.connector,
            actorId: event.actor.id,
            conversationId: event.conversation.id,
            eventId: event.id,
          },
          deliverChallenge: (challenge) => relay.deliver(challenge),
        });
        options.reporter?.emit({
          type: result.state === 'authorization_pending' ? 'coding.github.auth.challenge_available' : 'coding.github.auth.failed',
          taskId: event.id,
          status: result.state,
          summary: result.state === 'authorization_pending'
            ? 'GitHub browser authorization challenge is available to the initiating connector.'
            : 'GitHub browser authorization could not start.',
          evidence: result.authSessionId ? [result.authSessionId] : [],
          ...(result.failureCode ? { decision: result.failureCode } : {}),
        });
        return JSON.stringify(result, null, 2);
      },
    }),
  ];
}

function resolveTrustedEvent(
  resolver: (eventId: string) => NormalizedMessageEvent | undefined,
  eventId: string,
): NormalizedMessageEvent {
  const event = resolver(eventId);
  if (!event) {
    throw new Error('GitHub authentication requires a trusted eventId persisted by chat ingress.');
  }
  return event;
}

function stableSessionId(eventId: string, profile: string): string {
  return createHash('sha256').update(`${eventId}\u0000${profile}`).digest('hex').slice(0, 32);
}

function resolvePersistedEvent(eventId: string): NormalizedMessageEvent | undefined {
  return goromboPersistenceRuntime.sessionDatabase.getNormalizedMessageEvent(eventId) ?? undefined;
}
