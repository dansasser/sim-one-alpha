import { Box, Text } from 'ink';
import React from 'react';

export interface StatusLineProps {
  status: string;
  error: Error | undefined;
}

const STATUS_COLOR: Record<string, string> = {
  idle: 'gray',
  connecting: 'yellow',
  submitted: 'cyan',
  streaming: 'green',
  error: 'red',
};

const STATUS_LABEL: Record<string, string> = {
  idle: 'idle',
  connecting: 'connecting…',
  submitted: 'submitted…',
  streaming: 'streaming…',
  error: 'error',
};

export function StatusLine({ status, error }: StatusLineProps) {
  const color = STATUS_COLOR[status] ?? 'gray';
  const label = STATUS_LABEL[status] ?? status;

  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text dimColor>status: </Text>
      <Text bold color={color}>{label}</Text>
      <Box flexGrow={1} />
      {error && (
        <Text color="red" wrap="truncate">
          {error.message}
        </Text>
      )}
    </Box>
  );
}