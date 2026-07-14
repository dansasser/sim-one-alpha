import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import { goromboPersistenceRuntime } from '../../../../db.js';
import type { NormalizedMessageEvent } from '../../../../core/types/index.js';
import type { TrustedEventAdmission } from '../../../session/session-database.js';
import { getGithubAuthChallengeRelay, type GithubAuthChallengeRelay } from '../../../../api/ingress/github-auth-challenge-relay.js';
import { getTrustedMessageEvent } from '../../../../api/ingress/trusted-event-context.js';
import type { CodingApprovalService } from '../approvals/approval-service.js';
import { createInMemoryCodingApprovalService } from '../approvals/approval-service.js';
import { evaluateGitApproval } from '../tools/coding-git-tools.js';
import type { CodingProgressReporter } from '../events/progress-reporter.js';
import {
  type GithubAuthService,
} from './github-auth-service.js';
import { getGithubAuthService } from './github-auth-runtime.js';
import {
  createGithubAuthSessionId,
  toModelVisibleGithubAuthResult,
} from './github-auth-utils.js';

export interface CodingGithubAuthToolsOptions {
  workspaceRoot: string;
  authRoot?: string;
  env?: Record<string, string | undefined>;
  approvalService?: CodingApprovalService;
  reporter?: CodingProgressReporter;
  authService?: GithubAuthService;
  authServiceLoader?: () => Promise<GithubAuthService>;
  challengeRelay?: GithubAuthChallengeRelay;
  currentEventId?: string;
  trustedAgentInstanceId?: string;
  resolveEvent?(eventId: string): NormalizedMessageEvent | undefined;
  resolveAdmissionForAgent?(agentInstanceId: string, eventId: string): TrustedEventAdmission | undefined;
}

export function createCodingGithubAuthTools(options: CodingGithubAuthToolsOptions): ToolDefinition[] {
  const approvalService = options.approvalService ?? createInMemoryCodingApprovalService();
  const relay = options.challengeRelay ?? getGithubAuthChallengeRelay();
  const getService = async () => options.authService ?? options.authServiceLoader?.() ?? getGithubAuthService({
      workspaceRoot: options.workspaceRoot,
      authRoot: options.authRoot,
      env: options.env,
    });
  const resolveEvent = options.resolveEvent ?? resolvePersistedEvent;
  const resolveAdmissionForAgent = options.resolveAdmissionForAgent ?? resolvePersistedAdmissionForAgent;

  return [
    defineTool({
      name: 'github_auth_status',
      description: 'Check Coding Worker managed GitHub authentication for the trusted chat event. Read-only.',
      parameters: v.object({ eventId: v.string() }),
      execute: async ({ eventId }) => {
        resolveTrustedEvent({
          resolver: resolveEvent,
          admissionResolver: resolveAdmissionForAgent,
          eventId,
          currentEventId: options.currentEventId,
          trustedAgentInstanceId: options.trustedAgentInstanceId,
        });
        return JSON.stringify(toModelVisibleGithubAuthResult(await (await getService()).status()), null, 2);
      },
    }),
    defineTool({
      name: 'github_auth_start',
      description: 'Request approval and start managed HTTPS GitHub browser authorization for the trusted chat event.',
      parameters: v.object({
        eventId: v.string(),
        approvalRequestId: v.optional(v.string()),
      }),
      execute: async ({ eventId, approvalRequestId }) => {
        const event = resolveTrustedEvent({
          resolver: resolveEvent,
          admissionResolver: resolveAdmissionForAgent,
          eventId,
          currentEventId: options.currentEventId,
          trustedAgentInstanceId: options.trustedAgentInstanceId,
        });
        const profile = 'default';
        const service = await getService();
        const currentStatus = await service.status({ profile });
        if (currentStatus.state === 'authenticated') {
          return JSON.stringify(toModelVisibleGithubAuthResult(currentStatus), null, 2);
        }
        let authSessionId = createGithubAuthSessionId(event.id, profile);
        const approval = approvalRequestId
          ? await resolveApprovedContinuation(approvalService, approvalRequestId, event, profile)
          : await evaluateGitApproval({ reporter: options.reporter }, {
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
        const approvedSessionId = approval.request.metadata?.authSessionId;
        if (typeof approvedSessionId === 'string' && approvedSessionId.length > 0) {
          authSessionId = approvedSessionId;
        }
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
        const result = await service.start({
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
        return JSON.stringify(toModelVisibleGithubAuthResult(result), null, 2);
      },
    }),
  ];
}

async function resolveApprovedContinuation(
  approvalService: CodingApprovalService,
  requestId: string,
  event: NormalizedMessageEvent,
  profile: string,
) {
  const record = await approvalService.getRecord(requestId);
  if (!record || record.request.actionType !== 'github.auth.login') {
    throw new Error('GitHub authentication continuation approval was not found.');
  }
  const metadata = record.request.metadata;
  if (metadata?.connector !== event.connector ||
      metadata?.actorId !== event.actor.id ||
      metadata?.conversationId !== event.conversation.id ||
      metadata?.hostname !== 'github.com' ||
      metadata?.profile !== profile) {
    throw new Error('GitHub authentication continuation does not match the current trusted audience.');
  }
  return {
    request: record.request,
    evaluation: await approvalService.evaluateRequest(record.request),
  };
}

function resolveTrustedEvent(input: {
  resolver: (eventId: string) => NormalizedMessageEvent | undefined;
  admissionResolver: (agentInstanceId: string, eventId: string) => TrustedEventAdmission | undefined;
  eventId: string;
  currentEventId?: string;
  trustedAgentInstanceId?: string;
}): NormalizedMessageEvent {
  const contextualEvent = getTrustedMessageEvent();
  if (input.currentEventId !== undefined) {
    if (input.eventId !== input.currentEventId) {
      throw new Error('GitHub authentication requires the current trusted eventId.');
    }
    const currentEvent = contextualEvent?.id === input.currentEventId
      ? contextualEvent
      : input.resolver(input.currentEventId);
    if (!currentEvent) {
      throw new Error('GitHub authentication requires a trusted eventId persisted by chat ingress.');
    }
    return currentEvent;
  }
  if (contextualEvent) {
    if (input.eventId !== contextualEvent.id) {
      throw new Error('GitHub authentication requires the current trusted eventId.');
    }
    return contextualEvent;
  }
  if (input.trustedAgentInstanceId) {
    const admission = input.admissionResolver(input.trustedAgentInstanceId, input.eventId);
    const event = input.resolver(input.eventId);
    const expiresAt = admission ? Date.parse(admission.expiresAt) : Number.NaN;
    if (!admission ||
        admission.purpose !== 'github.auth' ||
        admission.eventId !== input.eventId ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= Date.now() ||
        !event ||
        admission.connector !== event.connector ||
        admission.actorId !== event.actor.id ||
        admission.conversationId !== event.conversation.id) {
      throw new Error('GitHub authentication requires a matching unexpired trusted event admission.');
    }
    return event;
  }
  throw new Error('GitHub authentication requires a current trusted event context or event admission.');
}

function resolvePersistedEvent(eventId: string): NormalizedMessageEvent | undefined {
  return goromboPersistenceRuntime.sessionDatabase.getNormalizedMessageEvent(eventId) ?? undefined;
}

function resolvePersistedAdmissionForAgent(
  agentInstanceId: string,
  eventId: string,
): TrustedEventAdmission | undefined {
  return goromboPersistenceRuntime.sessionDatabase.getTrustedEventAdmissionForAgent(agentInstanceId, eventId);
}
