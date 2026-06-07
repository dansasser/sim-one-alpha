import type { AgentModelProfile } from '../types.js';

export function providerContextWindow(card: AgentModelProfile): number {
  return card.providerReportedContextWindow ?? card.guaranteedContextWindow ?? card.contextWindow;
}
