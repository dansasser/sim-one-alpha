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
const shellWrapperCommands = new Set(['sh', 'bash', 'zsh', 'fish', 'cmd', 'powershell', 'pwsh']);

export function evaluateCodingShellCommand(command: string): CodingCommandPolicyResult {
  return evaluateCodingShellCommandText(command, new Set<string>());
}

function evaluateCodingShellCommandText(
  command: string,
  seenCommands: Set<string>,
): CodingCommandPolicyResult {
  const normalizedCommand = command.trim();
  if (!normalizedCommand) {
    return { allowed: true };
  }
  if (seenCommands.has(normalizedCommand)) {
    return { allowed: true };
  }
  seenCommands.add(normalizedCommand);

  for (const nestedCommand of extractCommandSubstitutions(normalizedCommand)) {
    const nestedPolicy = evaluateCodingShellCommandText(nestedCommand, seenCommands);
    if (!nestedPolicy.allowed) {
      return nestedPolicy;
    }
  }

  for (const segment of splitCommandSegments(normalizedCommand)) {
    const tokens = tokenizeShellLike(segment);
    const tokenPolicy = evaluateCommandTokens(tokens);
    if (!tokenPolicy.allowed) {
      return tokenPolicy;
    }

    for (const shellCommand of extractShellWrapperCommands(tokens)) {
      const nestedPolicy = evaluateCodingShellCommandText(shellCommand, seenCommands);
      if (!nestedPolicy.allowed) {
        return nestedPolicy;
      }
    }
  }

  return { allowed: true };
}

function evaluateCommandTokens(tokens: string[]): CodingCommandPolicyResult {
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
    return isReadOnlyGhApiCommand(tokens);
  }

  const pair = `${tokens[0]?.toLowerCase() ?? ''} ${tokens[1]?.toLowerCase() ?? ''}`;
  return ghReadOnlyPairs.has(pair);
}

function isReadOnlyGhApiCommand(tokens: string[]): boolean {
  const method = readGhApiMethod(tokens);
  if (method && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return false;
  }
  if (hasGhApiInputBody(tokens)) {
    return false;
  }
  if (hasGhApiFieldParameters(tokens) && method !== 'GET') {
    return false;
  }
  return true;
}

function readGhApiMethod(tokens: string[]): string | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }
    const normalized = token.toUpperCase();
    const compactMethod = /^-X([A-Z]+)$/.exec(normalized);
    if (compactMethod?.[1]) {
      return compactMethod[1];
    }
    const longMethod = /^--METHOD=([A-Z]+)$/.exec(normalized);
    if (longMethod?.[1]) {
      return longMethod[1];
    }
    if (normalized === '-X' || normalized === '--METHOD') {
      return tokens[index + 1]?.toUpperCase();
    }
  }
  return undefined;
}

function hasGhApiInputBody(tokens: string[]): boolean {
  return tokens.some((token) => {
    const normalized = token.toLowerCase();
    return normalized === '--input' || normalized.startsWith('--input=');
  });
}

function hasGhApiFieldParameters(tokens: string[]): boolean {
  return tokens.some((token) => {
    const normalized = token.toLowerCase();
    return (
      token === '-f' ||
      token.startsWith('-f') ||
      token === '-F' ||
      token.startsWith('-F') ||
      normalized === '--raw-field' ||
      normalized.startsWith('--raw-field=') ||
      normalized === '--field' ||
      normalized.startsWith('--field=')
    );
  });
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

function extractShellWrapperCommands(tokens: string[]): string[] {
  const commands: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (!isShellWrapperCommand(tokens[index])) {
      continue;
    }
    for (let flagIndex = index + 1; flagIndex < tokens.length - 1; flagIndex += 1) {
      if (isShellCommandFlag(tokens[flagIndex])) {
        commands.push(tokens[flagIndex + 1]);
        break;
      }
    }
  }
  return commands;
}

function isShellWrapperCommand(token: string | undefined): boolean {
  if (!token) {
    return false;
  }
  const normalized = token.toLowerCase().replace(/\\/g, '/');
  const basename = normalized.split('/').at(-1) ?? normalized;
  return shellWrapperCommands.has(basename) || shellWrapperCommands.has(basename.replace(/\.exe$/, ''));
}

function isShellCommandFlag(token: string | undefined): boolean {
  if (!token) {
    return false;
  }
  const normalized = token.toLowerCase();
  return (
    normalized === '-c' ||
    normalized === '/c' ||
    normalized === '--command' ||
    normalized === '-command' ||
    /^-[a-z]*c[a-z]*$/.test(normalized)
  );
}

function extractCommandSubstitutions(command: string): string[] {
  const substitutions: string[] = [];
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === '`') {
      const endIndex = command.indexOf('`', index + 1);
      if (endIndex > index) {
        substitutions.push(command.slice(index + 1, endIndex));
        index = endIndex;
      }
      continue;
    }

    if (char === '$' && command[index + 1] === '(') {
      const endIndex = findCommandSubstitutionEnd(command, index + 2);
      if (endIndex > index) {
        substitutions.push(command.slice(index + 2, endIndex));
        index = endIndex;
      }
    }
  }
  return substitutions;
}

function findCommandSubstitutionEnd(command: string, startIndex: number): number {
  let depth = 1;
  let quote: '"' | "'" | '`' | undefined;

  for (let index = startIndex; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function splitCommandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||\r?\n|[;|]/)
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
