import { Box, Text } from 'ink';
import React from 'react';

export interface SubagentViewProps {
  toolCallId: string;
  agentName: string;
  state: 'input-available' | 'output-available' | 'output-error';
  input: unknown;
  output?: unknown;
  errorText?: string;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  const json = JSON.stringify(value);
  return truncate(json, 200);
}

const STATE_COLOR: Record<SubagentViewProps['state'], string> = {
  'input-available': 'yellow',
  'output-available': 'green',
  'output-error': 'red',
};

const STATE_LABEL: Record<SubagentViewProps['state'], string> = {
  'input-available': 'delegating…',
  'output-available': 'returned',
  'output-error': 'failed',
};

export function SubagentView({ agentName, state, input, output, errorText }: SubagentViewProps) {
  const color = STATE_COLOR[state];
  const label = STATE_LABEL[state];

  return (
    <Box flexDirection="column" marginLeft={2} marginY={0}>
      <Box>
        <Text color="blue" bold>→ delegated to </Text>
        <Text color="blue" bold>{agentName}</Text>
        <Text color={color}> [{label}]</Text>
      </Box>
      <Text dimColor>  task: {formatValue(input)}</Text>
      {state === 'output-available' && output !== undefined && (
        <Text color="green">  result: {formatValue(output)}</Text>
      )}
      {state === 'output-error' && errorText && (
        <Text color="red">  error: {truncate(errorText, 200)}</Text>
      )}
    </Box>
  );
}