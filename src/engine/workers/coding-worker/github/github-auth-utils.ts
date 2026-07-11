import { createHash } from 'node:crypto';
import type { GithubAuthResult } from './github-auth-types.js';

export function createGithubAuthSessionId(eventId: string, profile: string): string {
  return createHash('sha256').update(`${eventId}\u0000${profile}`).digest('hex').slice(0, 32);
}

export function toModelVisibleGithubAuthResult(result: GithubAuthResult): Omit<GithubAuthResult, 'expiresAt'> {
  const { expiresAt: _privateExpiry, ...visible } = result;
  return visible;
}
