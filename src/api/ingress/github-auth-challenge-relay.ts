import type {
  GithubAuthAudience,
  GithubAuthChallenge,
} from '../../engine/workers/coding-worker/github/github-auth-types.js';

export interface DeliveredGithubAuthChallenge {
  sessionId: string;
  verificationUri: 'https://github.com/login/device';
  userCode: string;
  expiresAt: string;
}

export interface GithubAuthChallengeRelay {
  deliver(challenge: GithubAuthChallenge): void;
  consume(audience: GithubAuthAudience): DeliveredGithubAuthChallenge | undefined;
}

/**
 * Holds a device challenge only long enough to return it through the initiating
 * connector response. This deliberately has no persistence or progress-event
 * integration: a device code is a temporary authorization capability.
 */
export class InMemoryGithubAuthChallengeRelay implements GithubAuthChallengeRelay {
  readonly #challenges = new Map<string, GithubAuthChallenge>();

  deliver(challenge: GithubAuthChallenge): void {
    this.#challenges.set(challenge.audience.eventId, { ...challenge, audience: { ...challenge.audience } });
  }

  consume(audience: GithubAuthAudience): DeliveredGithubAuthChallenge | undefined {
    const challenge = this.#challenges.get(audience.eventId);
    if (!challenge || !sameAudience(challenge.audience, audience)) {
      return undefined;
    }
    this.#challenges.delete(audience.eventId);
    if (Date.parse(challenge.expiresAt) <= Date.now()) {
      return undefined;
    }
    return {
      sessionId: challenge.sessionId,
      verificationUri: challenge.verificationUri,
      userCode: challenge.userCode,
      expiresAt: challenge.expiresAt,
    };
  }
}

const defaultRelay = new InMemoryGithubAuthChallengeRelay();

export function getGithubAuthChallengeRelay(): GithubAuthChallengeRelay {
  return defaultRelay;
}

function sameAudience(left: GithubAuthAudience, right: GithubAuthAudience): boolean {
  return left.connector === right.connector &&
    left.actorId === right.actorId &&
    left.conversationId === right.conversationId &&
    left.eventId === right.eventId;
}
