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
  acquire(audience: GithubAuthAudience): GithubAuthChallengeLease | undefined;
  consume(audience: GithubAuthAudience): DeliveredGithubAuthChallenge | undefined;
  subscribe(listener: GithubAuthChallengeListener): () => void;
}

export type GithubAuthChallengeListener = (audience: GithubAuthAudience) => void;

export interface GithubAuthChallengeLease {
  challenge: DeliveredGithubAuthChallenge;
  ack(): boolean;
  release(): boolean;
}

/**
 * Holds a device challenge only long enough to deliver it through its trusted
 * connector. This deliberately has no persistence or progress-event integration:
 * a device code is a temporary authorization capability.
 */
export class InMemoryGithubAuthChallengeRelay implements GithubAuthChallengeRelay {
  readonly #challenges = new Map<string, StoredChallenge>();
  readonly #listeners = new Set<GithubAuthChallengeListener>();

  subscribe(listener: GithubAuthChallengeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

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
    for (const listener of this.#listeners) {
      try {
        listener({ ...challenge.audience });
      } catch {
        // Connector delivery failures must not mutate the authorization session.
      }
    }
  }

  acquire(audience: GithubAuthAudience): GithubAuthChallengeLease | undefined {
    const match = this.#findChallenge(audience);
    if (!match) {
      return undefined;
    }
    const [eventId, stored] = match;
    const challenge = stored.challenge;
    const expiresAt = Date.parse(challenge.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      if (stored.expiryTimer) clearTimeout(stored.expiryTimer);
      if (this.#challenges.get(eventId) === stored) {
        this.#challenges.delete(eventId);
      }
      return undefined;
    }
    if (stored.reservation) return undefined;

    const reservation = Symbol('github-auth-challenge-reservation');
    stored.reservation = reservation;
    let settled = false;
    const settle = (consume: boolean): boolean => {
      if (settled) return false;
      settled = true;
      if (this.#challenges.get(eventId) !== stored || stored.reservation !== reservation) {
        return false;
      }
      if (consume) {
        if (stored.expiryTimer) clearTimeout(stored.expiryTimer);
        this.#challenges.delete(eventId);
      } else {
        stored.reservation = undefined;
      }
      return true;
    };
    return {
      challenge: {
        sessionId: challenge.sessionId,
        verificationUri: challenge.verificationUri,
        userCode: challenge.userCode,
        expiresAt: challenge.expiresAt,
      },
      ack: () => settle(true),
      release: () => settle(false),
    };
  }

  consume(audience: GithubAuthAudience): DeliveredGithubAuthChallenge | undefined {
    const lease = this.acquire(audience);
    if (!lease) return undefined;
    lease.ack();
    return lease.challenge;
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
  reservation?: symbol;
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
