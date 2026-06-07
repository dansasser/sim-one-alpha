import type { PromptUsage } from '@flue/runtime';
import type { AgentModelProfile } from '../models/types.js';
import { type CompactionStatus, evaluateCompaction } from './compaction-policy.js';
import { calculateContextBudget, estimateTextTokens, type ContextBudget } from './context-budget.js';

export interface SessionBudgetState {
  sessionId: string;
  modelSpecifier: string;
  estimatedHistoryTokens: number;
  turns: number;
  compactions: number;
  updatedAt?: string;
}

export interface SessionBudgetReport {
  modelSpecifier: string;
  enforcedContextWindow: number;
  outputReserveTokens: number;
  usableInputTokens: number;
  warningTokens: number;
  compactionTokens: number;
  hardStopTokens: number;
  estimatedHistoryTokens: number;
  estimatedPromptTokens: number;
  estimatedUsedTokens: number;
  remainingInputTokens: number;
  overageTokens: number;
  status: CompactionStatus;
  shouldCompactBeforePrompt: boolean;
  turns: number;
  compactions: number;
}

export interface CreateSessionBudgetReportInput {
  sessionId?: string;
  modelCard: AgentModelProfile;
  promptText?: string;
  store?: SessionBudgetStore;
}

export interface RecordPromptUsageInput {
  sessionId: string;
  modelSpecifier: string;
  promptEstimateTokens: number;
  usage: PromptUsage;
  store?: SessionBudgetStore;
}

export interface RecordManualCompactionInput {
  sessionId: string;
  modelSpecifier: string;
  budget: ContextBudget;
  store?: SessionBudgetStore;
}

export interface SessionBudgetStore {
  get(sessionId: string, modelSpecifier: string): SessionBudgetState;
  save(state: SessionBudgetState): void;
}

export class InMemorySessionBudgetStore implements SessionBudgetStore {
  private readonly states = new Map<string, SessionBudgetState>();

  get(sessionId: string, modelSpecifier: string): SessionBudgetState {
    const key = storeKey(sessionId, modelSpecifier);
    const existing = this.states.get(key);
    if (existing) {
      return { ...existing };
    }

    return {
      sessionId,
      modelSpecifier,
      estimatedHistoryTokens: 0,
      turns: 0,
      compactions: 0,
    };
  }

  save(state: SessionBudgetState): void {
    this.states.set(storeKey(state.sessionId, state.modelSpecifier), {
      ...state,
      estimatedHistoryTokens: Math.max(0, Math.floor(state.estimatedHistoryTokens)),
      turns: Math.max(0, Math.floor(state.turns)),
      compactions: Math.max(0, Math.floor(state.compactions)),
      updatedAt: new Date().toISOString(),
    });
  }

  setForTest(state: SessionBudgetState): void {
    this.save(state);
  }
}

export const chatSessionBudgetStore = new InMemorySessionBudgetStore();

export function createSessionBudgetReport(input: CreateSessionBudgetReportInput): SessionBudgetReport {
  const budget = calculateContextBudget(input.modelCard);
  const sessionId = input.sessionId ?? 'stateless';
  const store = input.store ?? chatSessionBudgetStore;
  const state = store.get(sessionId, input.modelCard.specifier);
  const estimatedPromptTokens = estimateTextTokens(input.promptText ?? '');
  const estimatedUsedTokens = state.estimatedHistoryTokens + estimatedPromptTokens;
  const decision = evaluateCompaction({
    usedTokens: estimatedUsedTokens,
    warningTokens: budget.warningTokens,
    compactionTokens: budget.compactionTokens,
    hardStopTokens: budget.hardStopTokens,
  });

  return {
    modelSpecifier: input.modelCard.specifier,
    enforcedContextWindow: budget.enforcedContextWindow,
    outputReserveTokens: budget.outputReserveTokens,
    usableInputTokens: budget.usableInputTokens,
    warningTokens: budget.warningTokens,
    compactionTokens: budget.compactionTokens,
    hardStopTokens: budget.hardStopTokens,
    estimatedHistoryTokens: state.estimatedHistoryTokens,
    estimatedPromptTokens,
    estimatedUsedTokens,
    remainingInputTokens: decision.remainingTokens,
    overageTokens: decision.overageTokens,
    status: decision.status,
    shouldCompactBeforePrompt: decision.shouldCompactBeforePrompt,
    turns: state.turns,
    compactions: state.compactions,
  };
}

export function recordPromptUsage(input: RecordPromptUsageInput): void {
  const store = input.store ?? chatSessionBudgetStore;
  const state = store.get(input.sessionId, input.modelSpecifier);
  const providerReportedTokens = promptUsageTokens(input.usage);
  const fallbackTokens = state.estimatedHistoryTokens + input.promptEstimateTokens + input.usage.output;

  store.save({
    ...state,
    estimatedHistoryTokens: Math.max(providerReportedTokens, fallbackTokens),
    turns: state.turns + 1,
  });
}

export function recordManualCompaction(input: RecordManualCompactionInput): void {
  const store = input.store ?? chatSessionBudgetStore;
  const state = store.get(input.sessionId, input.modelSpecifier);
  const summaryAllowance = Math.min(16_000, Math.floor(input.budget.outputReserveTokens / 2));
  const postCompactionEstimate = Math.min(
    state.estimatedHistoryTokens,
    input.budget.keepRecentTokens + summaryAllowance,
    Math.max(0, input.budget.compactionTokens - 1),
  );

  store.save({
    ...state,
    estimatedHistoryTokens: postCompactionEstimate,
    compactions: state.compactions + 1,
  });
}

function promptUsageTokens(usage: PromptUsage): number {
  return Math.max(
    usage.totalTokens,
    usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    usage.input + usage.output,
  );
}

function storeKey(sessionId: string, modelSpecifier: string): string {
  return `${sessionId}\u0000${modelSpecifier}`;
}
