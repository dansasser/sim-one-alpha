import { Box, Text } from 'ink';
import React from 'react';
import TextInput from 'ink-text-input';

export interface BottomSectionProps {
  inputValue: string;
  onInputChange: (value: string) => void;
  onSubmit: (value: string) => void;
  agentStatus: string;
  messageCount: number;
  inputDisabled: boolean;
}

const STATUS_COLOR: Record<string, string> = {
  idle: 'gray',
  connecting: 'yellow',
  submitted: 'cyan',
  streaming: 'green',
  error: 'red',
};

export function BottomSection({
  inputValue,
  onInputChange,
  onSubmit,
  agentStatus,
  messageCount,
  inputDisabled,
}: BottomSectionProps) {
  const statusColor = STATUS_COLOR[agentStatus] ?? 'gray';

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between" paddingX={1}>
        <Box>
          <Text dimColor>messages: </Text>
          <Text bold>{messageCount}</Text>
        </Box>
        <Box>
          <Text dimColor>agent: </Text>
          <Text bold color={statusColor}>{agentStatus}</Text>
        </Box>
      </Box>
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text color="green" bold>{'❯ '}</Text>
        {inputDisabled ? (
          <Text color="gray" italic>waiting for agent…</Text>
        ) : (
          <TextInput
            value={inputValue}
            onChange={onInputChange}
            onSubmit={onSubmit}
            placeholder="Type a message and press Enter…"
          />
        )}
      </Box>
    </Box>
  );
}