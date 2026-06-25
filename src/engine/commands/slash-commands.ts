export type SlashCommandName = 'new' | 'compact';

export interface ParsedSlashCommand {
  raw: string;
  name: SlashCommandName | string;
  args: string;
}

const supportedCommands = new Set<SlashCommandName>(['new', 'compact']);

export function parseSlashCommand(text: string): ParsedSlashCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return undefined;
  }

  const match = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) {
    return undefined;
  }

  return {
    raw: trimmed,
    name: match[1]?.toLowerCase() ?? '',
    args: match[2]?.trim() ?? '',
  };
}

export function isSupportedSlashCommand(command: ParsedSlashCommand): command is ParsedSlashCommand & {
  name: SlashCommandName;
} {
  return supportedCommands.has(command.name as SlashCommandName);
}

export function isSessionCreationSlashCommand(command: ParsedSlashCommand): boolean {
  return command.name === 'new';
}
