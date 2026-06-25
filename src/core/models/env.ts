import type { AgentModelCard } from '../../core/models/types.js';

export interface ResolvedModelEnv {
  apiKey?: string;
  baseUrl?: string;
}

export function resolveModelCardEnv(
  card: AgentModelCard,
  env: Record<string, unknown> = process.env,
): ResolvedModelEnv {
  return {
    apiKey: resolveEnvValue(card.env?.apiKey, env),
    baseUrl: resolveEnvValue(card.env?.baseUrl, env),
  };
}

export function resolveProviderCardEnv(
  cards: readonly AgentModelCard[],
  env: Record<string, unknown> = process.env,
): ResolvedModelEnv {
  for (const card of cards) {
    const resolved = resolveModelCardEnv(card, env);
    if (resolved.apiKey || resolved.baseUrl) {
      return resolved;
    }
  }

  return {};
}

export function resolveEnvValue(
  names: string | string[] | undefined,
  env: Record<string, unknown> = process.env,
): string | undefined {
  const candidates = typeof names === 'string' ? [names] : names ?? [];

  for (const name of candidates) {
    const value = env[name];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}
