import { Box, Text, useStdout, useFocus, useFocusManager, useInput } from 'ink';
import React, { useEffect } from 'react';
import { ScrollableBox } from 'ink-scrollable-box';
import type { UIMessage, UIMessagePart } from '@flue/react';

export interface InputOutputSectionProps {
  messages: UIMessage[];
}

type DynamicToolPart = Extract<UIMessagePart, { type: 'dynamic-tool' }>;

function isToolPart(part: UIMessagePart): part is DynamicToolPart {
  return part.type === 'dynamic-tool';
}

function isSubagentDelegation(part: DynamicToolPart): boolean {
  if (part.toolName !== 'task') return false;
  if (typeof part.input !== 'object' || part.input === null) return false;
  return 'agent' in part.input;
}

function getAgentName(part: DynamicToolPart): string {
  const input = part.input as Record<string, unknown>;
  return typeof input.agent === 'string' ? input.agent : 'unknown';
}

const ROLE_LABEL: Record<string, string> = {
  user: 'you',
  assistant: 'assistant',
  system: 'system',
};

const TOOL_STATE_ICON: Record<string, string> = {
  'input-available': '⏳',
  'output-available': '✓',
  'output-error': '✗',
};

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  try {
    return truncate(JSON.stringify(value), 80);
  } catch {
    return '[unable to serialize]';
  }
}

function messageToLines(message: UIMessage): string[] {
  const lines: string[] = [];
  const label = ROLE_LABEL[message.role] ?? message.role;

  if (message.parts.length === 0) return lines;

  lines.push(`${label}:`);

  for (const part of message.parts) {
    if (part.type === 'text') {
      for (const line of part.text.split('\n')) {
        lines.push(`  ${line}`);
      }
    } else if (part.type === 'reasoning') {
      lines.push(`  [thinking] ${truncate(part.text, 60)}`);
    } else if (part.type === 'file') {
      lines.push(`  [file: ${part.mediaType}]`);
    } else if (isToolPart(part)) {
      const icon = TOOL_STATE_ICON[part.state] ?? '?';
      if (isSubagentDelegation(part)) {
        const agentName = getAgentName(part);
        lines.push(`  ${icon} → delegated to ${agentName}`);
        lines.push(`    task: ${formatValue(part.input)}`);
        if (part.state === 'output-available' && part.output !== undefined) {
          lines.push(`    result: ${formatValue(part.output)}`);
        }
        if (part.state === 'output-error' && part.errorText) {
          lines.push(`    error: ${truncate(part.errorText, 80)}`);
        }
      } else {
        lines.push(`  ${icon} ${part.toolName}  ${truncate(formatValue(part.input), 50)}`);
        if (part.state === 'output-available' && part.output !== undefined) {
          lines.push(`    output: ${formatValue(part.output)}`);
        }
        if (part.state === 'output-error' && part.errorText) {
          lines.push(`    error: ${truncate(part.errorText, 80)}`);
        }
      }
    }
  }

  lines.push('');
  return lines;
}

export function InputOutputSection({ messages }: InputOutputSectionProps) {
  const { stdout } = useStdout();
  const { isFocused } = useFocus({ id: 'messages' });
  const viewportHeight = (stdout?.rows ?? 24) - 4;

  const lines = React.useMemo(() => {
    const allLines: string[] = [];
    for (const message of messages) {
      allLines.push(...messageToLines(message));
    }
    return allLines;
  }, [messages]);

  return (
    <Box flexGrow={1} flexDirection="column">
      {isFocused && (
        <Box paddingX={1}>
          <Text dimColor italic>↑↓ to scroll, Tab for input</Text>
        </Box>
      )}
      <ScrollableBox
        height={isFocused ? viewportHeight - 1 : viewportHeight}
        lines={lines}
        followOutput={true}
        focusable={true}
        autoFocus={false}
        showScrollbar={true}
        showIndicators={true}
      />
    </Box>
  );
}