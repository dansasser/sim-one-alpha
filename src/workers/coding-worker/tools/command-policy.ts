export interface CodingCommandPolicyResult {
  allowed: boolean;
  reason?: string;
  approvalAction?: string;
}

const gitReadOnlySubcommands = new Set(['status', 'diff', 'log', 'show', 'rev-parse']);
const ghReadOnlyPairs = new Set([
  'auth status',
  'issue list',
  'issue view',
  'pr checks',
  'pr list',
  'pr view',
  'repo view',
]);

const gitGlobalOptionsWithValue = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

export function evaluateCodingShellCommand(command: string): CodingCommandPolicyResult {
  for (const segment of splitCommandSegments(command)) {
    const tokens = tokenizeShellLike(segment);
    const gitIndex = findCommandIndex(tokens, 'git');
    if (gitIndex >= 0 && !isReadOnlyGitCommand(tokens.slice(gitIndex + 1))) {
      return {
        allowed: false,
        reason: 'Git write commands must use the coding-worker approval-gated git/GitHub path.',
        approvalAction: 'git.write',
      };
    }

    const ghIndex = findCommandIndex(tokens, 'gh');
    if (ghIndex >= 0 && !isReadOnlyGhCommand(tokens.slice(ghIndex + 1))) {
      return {
        allowed: false,
        reason: 'GitHub write commands must use the coding-worker approval-gated GitHub path.',
        approvalAction: 'github.write',
      };
    }
  }

  return { allowed: true };
}

function isReadOnlyGitCommand(tokens: string[]): boolean {
  const subcommandIndex = findGitSubcommandIndex(tokens);
  if (subcommandIndex < 0) {
    return false;
  }

  const subcommand = tokens[subcommandIndex]?.toLowerCase();
  if (!subcommand) {
    return false;
  }

  if (gitReadOnlySubcommands.has(subcommand)) {
    return true;
  }

  return subcommand === 'branch' && tokens[subcommandIndex + 1] === '--show-current';
}

function isReadOnlyGhCommand(tokens: string[]): boolean {
  if (tokens[0] === 'api') {
    return !tokens.some((token, index) => {
      const previous = tokens[index - 1]?.toUpperCase();
      const normalized = token.toUpperCase();
      return (
        /^-X(POST|PUT|PATCH|DELETE)$/.test(normalized) ||
        /^--method=(POST|PUT|PATCH|DELETE)$/.test(normalized) ||
        ((previous === '-X' || previous === '--METHOD') &&
          ['POST', 'PUT', 'PATCH', 'DELETE'].includes(normalized))
      );
    });
  }

  const pair = `${tokens[0]?.toLowerCase() ?? ''} ${tokens[1]?.toLowerCase() ?? ''}`;
  return ghReadOnlyPairs.has(pair);
}

function findGitSubcommandIndex(tokens: string[]): number {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }
    if (token === '--') {
      return index + 1 < tokens.length ? index + 1 : -1;
    }
    if (gitGlobalOptionsWithValue.has(token)) {
      index += 1;
      continue;
    }
    if ([...gitGlobalOptionsWithValue].some((option) => token.startsWith(`${option}=`))) {
      continue;
    }
    if (token.startsWith('-')) {
      continue;
    }
    return index;
  }
  return -1;
}

function findCommandIndex(tokens: string[], command: 'git' | 'gh'): number {
  return tokens.findIndex((token) => {
    const normalized = token.toLowerCase().replace(/\\/g, '/');
    const basename = normalized.split('/').at(-1) ?? normalized;
    return basename === command || basename === `${command}.exe`;
  });
}

function splitCommandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||[;|]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function tokenizeShellLike(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}
