import type {
  GithubAuthAudience,
  GithubAuthChallenge,
} from '../../engine/workers/coding-worker/github/github-auth-types.js';
import type { NormalizedMessageEvent } from '../../core/types/index.js';
import {
  sameGithubAuthAudience,
  sameGithubAuthConversationAudience,
} from '../../engine/workers/coding-worker/github/github-auth-utils.js';

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
  readonly #challenges = new Map<string, StoredChallenge>();

  deliver(challenge: GithubAuthChallenge): void {
    const eventId = challenge.audience.eventId;
    const expiresAt = Date.parse(challenge.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      return;
    }

    const previous = this.#challenges.get(eventId);
    if (previous?.expiryTimer) clearTimeout(previous.expiryTimer);
    for (const [storedEventId, stored] of this.#challenges) {
      if (storedEventId !== eventId && sameGithubAuthConversationAudience(stored.challenge.audience, challenge.audience)) {
        if (stored.expiryTimer) clearTimeout(stored.expiryTimer);
        this.#challenges.delete(storedEventId);
      }
    }

    const stored: StoredChallenge = {
      challenge: { ...challenge, audience: { ...challenge.audience } },
    };
    this.#challenges.set(eventId, stored);
    this.#scheduleExpiry(eventId, stored, expiresAt);
  }

  consume(audience: GithubAuthAudience): DeliveredGithubAuthChallenge | undefined {
    const match = this.#findChallenge(audience);
    if (!match) {
      return undefined;
    }
    const [eventId, stored] = match;
    const challenge = stored.challenge;
    if (stored.expiryTimer) clearTimeout(stored.expiryTimer);
    if (this.#challenges.get(eventId) === stored) {
      this.#challenges.delete(eventId);
    }
    const expiresAt = Date.parse(challenge.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      return undefined;
    }
    return {
      sessionId: challenge.sessionId,
      verificationUri: challenge.verificationUri,
      userCode: challenge.userCode,
      expiresAt: challenge.expiresAt,
    };
  }

  #findChallenge(audience: GithubAuthAudience): [string, StoredChallenge] | undefined {
    const exact = this.#challenges.get(audience.eventId);
    if (exact && sameGithubAuthAudience(exact.challenge.audience, audience)) {
      return [audience.eventId, exact];
    }

    // A later authenticated chat turn has a new event id. It may continue the
    // approved flow only inside the same connector/actor/conversation scope.
    return [...this.#challenges.entries()].find(([, stored]) =>
      sameGithubAuthConversationAudience(stored.challenge.audience, audience));
  }

  #scheduleExpiry(eventId: string, stored: StoredChallenge, expiresAt: number): void {
    const delay = Math.min(expiresAt - Date.now(), 2_147_483_647);
    stored.expiryTimer = setTimeout(() => {
      if (this.#challenges.get(eventId) !== stored) return;
      if (expiresAt > Date.now()) {
        this.#scheduleExpiry(eventId, stored, expiresAt);
        return;
      }
      this.#challenges.delete(eventId);
    }, Math.max(0, delay));
    stored.expiryTimer.unref?.();
  }
}

interface StoredChallenge {
  challenge: GithubAuthChallenge;
  expiryTimer?: NodeJS.Timeout;
}

const defaultRelay = new InMemoryGithubAuthChallengeRelay();

export function getGithubAuthChallengeRelay(): GithubAuthChallengeRelay {
  return defaultRelay;
}

export function githubAuthAudienceFromEvent(event: NormalizedMessageEvent): GithubAuthAudience {
  return {
    connector: event.connector,
    actorId: event.actor.id,
    conversationId: event.conversation.id,
    eventId: event.id,
  };
}
