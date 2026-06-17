import type { PromptUsage } from '@flue/runtime';
import type { SessionData } from '@flue/runtime/adapter';
import type { AgentModelCard } from '../models/types.js';
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
  modelCard: AgentModelCard;
  promptText?: string;
  store?: SessionBudgetStore;
  sessionData?: SessionData | null;
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
  const state = input.sessionData
    ? deriveSessionBudgetStateFromData({
        sessionId,
        modelSpecifier: input.modelCard.specifier,
        data: input.sessionData,
      })
    : store.get(sessionId, input.modelCard.specifier);
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

export function deriveSessionBudgetStateFromData(input: {
  sessionId: string;
  modelSpecifier: string;
  data: SessionData;
}): SessionBudgetState {
  const activePath = getActivePath(input.data);
  const contextEntries = getContextEntries(activePath);

  return {
    sessionId: input.sessionId,
    modelSpecifier: input.modelSpecifier,
    estimatedHistoryTokens: estimateSessionContextTokens(contextEntries),
    turns: activePath.filter(isAssistantMessageEntry).length,
    compactions: activePath.filter((entry) => entry.type === 'compaction').length,
    updatedAt: input.data.updatedAt,
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

type SessionEntry = SessionData['entries'][number];
interface ContextBudgetEntry {
  entry: SessionEntry;
  useProviderUsage: boolean;
}

function getActivePath(data: SessionData): SessionEntry[] {
  if (!data.leafId) {
    return [];
  }

  const byId = new Map(data.entries.map((entry) => [entry.id, entry]));
  const path: SessionEntry[] = [];
  let cursor: string | null = data.leafId;

  while (cursor) {
    const entry = byId.get(cursor);
    if (!entry) {
      return data.entries;
    }
    path.unshift(entry);
    cursor = entry.parentId;
  }

  return path;
}

function getContextEntries(path: SessionEntry[]): ContextBudgetEntry[] {
  const latestCompactionIndex = findLatestCompactionIndex(path);
  if (latestCompactionIndex === -1) {
    return path.map((entry) => ({ entry, useProviderUsage: true }));
  }

  const compaction = path[latestCompactionIndex];
  if (!compaction || compaction.type !== 'compaction') {
    return path.map((entry) => ({ entry, useProviderUsage: true }));
  }

  const firstKeptIndex = path.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
  const keptStart = firstKeptIndex >= 0 ? firstKeptIndex : latestCompactionIndex + 1;

  return [
    { entry: compaction, useProviderUsage: false },
    ...path
      .slice(keptStart, latestCompactionIndex)
      .map((entry) => ({ entry, useProviderUsage: false })),
    ...path.slice(latestCompactionIndex + 1).map((entry) => ({ entry, useProviderUsage: true })),
  ];
}

function estimateSessionContextTokens(entries: ContextBudgetEntry[]): number {
  const latestCompactionIndex = findLatestCompactionIndex(entries);
  const latestUsableAssistantIndex = findLatestAssistantUsageIndex(entries, latestCompactionIndex);

  if (latestUsableAssistantIndex === -1) {
    return entries.reduce((total, entry) => total + estimateEntryTokens(entry), 0);
  }

  const assistant = entries[latestUsableAssistantIndex];
  const usageTokens =
    assistant && assistant.useProviderUsage && isAssistantMessageEntry(assistant.entry)
      ? readUsageTokens(assistant.entry.message.usage)
      : 0;
  const trailingTokens = entries
    .slice(latestUsableAssistantIndex + 1)
    .reduce((total, entry) => total + estimateEntryTokens(entry), 0);

  return usageTokens + trailingTokens;
}

function findLatestCompactionIndex(entries: readonly (SessionEntry | ContextBudgetEntry)[]): number {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = unwrapContextEntry(entries[i]);
    if (entry?.type === 'compaction') {
      return i;
    }
  }

  return -1;
}

function findLatestAssistantUsageIndex(entries: ContextBudgetEntry[], latestCompactionIndex: number): number {
  for (let i = entries.length - 1; i > latestCompactionIndex; i -= 1) {
    const entry = entries[i];
    if (
      entry?.useProviderUsage &&
      isAssistantMessageEntry(entry.entry) &&
      readUsageTokens(entry.entry.message.usage) > 0
    ) {
      return i;
    }
  }

  return -1;
}

type StoredMessageEntry = Extract<SessionEntry, { type: 'message' }>;
type StoredAssistantMessageEntry = StoredMessageEntry & {
  message: { role: 'assistant'; usage?: unknown; content?: unknown };
};

function isAssistantMessageEntry(entry: SessionEntry): entry is StoredAssistantMessageEntry {
  return entry.type === 'message' && entry.message.role === 'assistant';
}

function estimateEntryTokens(input: SessionEntry | ContextBudgetEntry): number {
  const entry = unwrapContextEntry(input);
  if (!entry) {
    return 0;
  }

  if (entry.type === 'compaction') {
    return estimateTextTokens(entry.summary);
  }

  // Historical 'branch_summary' entries are no longer a native Flue entry type in 1.0 beta.
  // Treat any remaining ones as compaction-like summaries for budget estimation.
  if ((entry as { type?: string }).type === 'branch_summary') {
    const summary = (entry as { summary?: unknown }).summary;
    return estimateTextTokens(typeof summary === 'string' ? summary : '');
  }

  if (entry.type === 'message') {
    return estimateMessageTokens(entry.message);
  }

  return 0;
}

function unwrapContextEntry(input: SessionEntry | ContextBudgetEntry | undefined): SessionEntry | undefined {
  if (!input) {
    return undefined;
  }

  return 'entry' in input ? input.entry : input;
}

function estimateMessageTokens(message: unknown): number {
  const content =
    message && typeof message === 'object' && 'content' in message
      ? (message as { content?: unknown }).content
      : undefined;
  if (typeof content === 'string') {
    return estimateTextTokens(content);
  }

  if (Array.isArray(content)) {
    return content.reduce((total, block) => {
      if (!block || typeof block !== 'object') {
        return total;
      }

      const candidate = block as { text?: unknown; thinking?: unknown; name?: unknown; arguments?: unknown };
      if (typeof candidate.text === 'string') {
        return total + estimateTextTokens(candidate.text);
      }
      if (typeof candidate.thinking === 'string') {
        return total + estimateTextTokens(candidate.thinking);
      }
      if (typeof candidate.name === 'string') {
        return total + estimateTextTokens(`${candidate.name} ${JSON.stringify(candidate.arguments ?? {})}`);
      }

      return total;
    }, 0);
  }

  return estimateTextTokens(JSON.stringify(content ?? ''));
}

function readUsageTokens(usage: unknown): number {
  if (!usage || typeof usage !== 'object') {
    return 0;
  }

  const candidate = usage as Partial<PromptUsage>;
  return Math.max(
    readTokenCount(candidate.totalTokens),
    readTokenCount(candidate.input) +
      readTokenCount(candidate.output) +
      readTokenCount(candidate.cacheRead) +
      readTokenCount(candidate.cacheWrite),
    readTokenCount(candidate.input) + readTokenCount(candidate.output),
  );
}

function readTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
