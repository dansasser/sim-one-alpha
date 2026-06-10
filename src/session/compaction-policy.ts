export type CompactionStatus = 'normal' | 'warn' | 'compact' | 'stop';

export interface CompactionPolicyInput {
  usedTokens: number;
  warningTokens: number;
  compactionTokens: number;
  hardStopTokens: number;
}

export interface CompactionDecision {
  status: CompactionStatus;
  usedTokens: number;
  remainingTokens: number;
  overageTokens: number;
  shouldCompactBeforePrompt: boolean;
}

export function evaluateCompaction(input: CompactionPolicyInput): CompactionDecision {
  const usedTokens = nonNegativeInteger(input.usedTokens, 'usedTokens');
  const hardStopTokens = nonNegativeInteger(input.hardStopTokens, 'hardStopTokens');
  const remainingTokens = Math.max(0, hardStopTokens - usedTokens);
  const overageTokens = Math.max(0, usedTokens - hardStopTokens);

  if (usedTokens > hardStopTokens) {
    return {
      status: 'stop',
      usedTokens,
      remainingTokens,
      overageTokens,
      shouldCompactBeforePrompt: true,
    };
  }

  if (usedTokens >= nonNegativeInteger(input.compactionTokens, 'compactionTokens')) {
    return {
      status: 'compact',
      usedTokens,
      remainingTokens,
      overageTokens,
      shouldCompactBeforePrompt: true,
    };
  }

  if (usedTokens >= nonNegativeInteger(input.warningTokens, 'warningTokens')) {
    return {
      status: 'warn',
      usedTokens,
      remainingTokens,
      overageTokens,
      shouldCompactBeforePrompt: false,
    };
  }

  return {
    status: 'normal',
    usedTokens,
    remainingTokens,
    overageTokens,
    shouldCompactBeforePrompt: false,
  };
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
  return Math.floor(value);
}
