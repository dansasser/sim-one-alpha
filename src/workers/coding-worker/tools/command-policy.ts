export interface CodingCommandPolicyResult {
  allowed: boolean;
  reason?: string;
  approvalAction?: string;
}

const gitWritePatterns = [
  /\bgit\s+commit\b/i,
  /\bgit\s+push\b/i,
  /\bgit\s+tag\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+checkout\s+--\b/i,
];

const githubWritePatterns = [
  /\bgh\s+pr\s+create\b/i,
  /\bgh\s+pr\s+edit\b/i,
  /\bgh\s+pr\s+merge\b/i,
  /\bgh\s+pr\s+review\b/i,
  /\bgh\s+pr\s+comment\b/i,
  /\bgh\s+issue\s+comment\b/i,
  /\bgh\s+api\b.*\b(--method|-X)\s+(POST|PATCH|PUT|DELETE)\b/i,
];

export function evaluateCodingShellCommand(command: string): CodingCommandPolicyResult {
  if (gitWritePatterns.some((pattern) => pattern.test(command))) {
    return {
      allowed: false,
      reason: 'Git write commands must use the coding-worker approval-gated git/GitHub path.',
      approvalAction: 'git.write',
    };
  }

  if (githubWritePatterns.some((pattern) => pattern.test(command))) {
    return {
      allowed: false,
      reason: 'GitHub write commands must use the coding-worker approval-gated GitHub path.',
      approvalAction: 'github.write',
    };
  }

  return { allowed: true };
}
