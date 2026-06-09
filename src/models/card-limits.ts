import type { AgentModelCard } from './types.js';

export function providerContextWindow(card: AgentModelCard): number {
  return card.providerReportedContextWindow ?? card.guaranteedContextWindow ?? card.contextWindow;
}
