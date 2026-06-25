import type { AgentModelCard } from '../../core/models/types.js';

export interface ContextBudgetInput {
  contextWindow: number;
  providerReportedContextWindow?: number;
  guaranteedContextWindow?: number;
  maxOutputTokens: number;
  warningRatio?: number;
  compactionRatio?: number;
  outputReserveRatio?: number;
  keepRecentTokens?: number;
}

export interface ContextBudget {
  advertisedContextWindow: number;
  enforcedContextWindow: number;
  outputReserveTokens: number;
  usableInputTokens: number;
  warningTokens: number;
  compactionTokens: number;
  hardStopTokens: number;
  compactionReserveTokens: number;
  keepRecentTokens: number;
}

const defaultWarningRatio = 0.7;
const defaultCompactionRatio = 0.85;
const defaultOutputReserveRatio = 0.25;
const defaultKeepRecentTokens = 8_000;

export function calculateContextBudget(input: ContextBudgetInput | AgentModelCard): ContextBudget {
  const options = input as Partial<ContextBudgetInput>;
  const advertisedContextWindow = positiveInteger(input.contextWindow, 'contextWindow');
  const enforcedContextWindow =
    readPositiveInteger(input.providerReportedContextWindow) ??
    readPositiveInteger(input.guaranteedContextWindow) ??
    advertisedContextWindow;
  const maxOutputTokens = positiveInteger(input.maxOutputTokens, 'maxOutputTokens');
  const warningRatio = ratio(options.warningRatio ?? defaultWarningRatio, 'warningRatio');
  const compactionRatio = ratio(options.compactionRatio ?? defaultCompactionRatio, 'compactionRatio');
  const outputReserveRatio = ratio(options.outputReserveRatio ?? defaultOutputReserveRatio, 'outputReserveRatio');
  const maxReserveByWindow = Math.floor(enforcedContextWindow * outputReserveRatio);
  const outputReserveTokens = Math.min(maxOutputTokens, maxReserveByWindow);
  const usableInputTokens = Math.max(0, enforcedContextWindow - outputReserveTokens);
  const warningTokens = Math.floor(usableInputTokens * warningRatio);
  const compactionTokens = Math.floor(usableInputTokens * compactionRatio);
  const compactionReserveTokens = Math.max(outputReserveTokens, enforcedContextWindow - compactionTokens);

  return {
    advertisedContextWindow,
    enforcedContextWindow,
    outputReserveTokens,
    usableInputTokens,
    warningTokens,
    compactionTokens,
    hardStopTokens: usableInputTokens,
    compactionReserveTokens,
    keepRecentTokens: readPositiveInteger(options.keepRecentTokens) ?? defaultKeepRecentTokens,
  };
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function positiveInteger(value: number, name: string): number {
  const parsed = readPositiveInteger(value);
  if (parsed === undefined) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function ratio(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be between 0 and 1.`);
  }
  return value;
}
