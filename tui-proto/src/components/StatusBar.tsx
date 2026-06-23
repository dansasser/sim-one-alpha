import { Box, Text } from 'ink';
import React from 'react';

export interface StatusBarProps {
  messageCount: number;
  pendingApprovals: number;
  agentStatus: string;
}

const STATUS_COLOR: Record<string, string> = {
  idle: 'gray',
  connecting: 'yellow',
  submitted: 'cyan',
  streaming: 'green',
  error: 'red',
};

export function StatusBar({ messageCount, pendingApprovals, agentStatus }: StatusBarProps) {
  const statusColor = STATUS_COLOR[agentStatus] ?? 'gray';

  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Box>
        <Text dimColor>messages: </Text>
        <Text bold>{messageCount}</Text>
      </Box>
      {pendingApprovals > 0 && (
        <Box>
          <Text dimColor>approvals: </Text>
          <Text bold color="yellow">{pendingApprovals}</Text>
        </Box>
      )}
      <Box>
        <Text dimColor>agent: </Text>
        <Text bold color={statusColor}>{agentStatus}</Text>
      </Box>
    </Box>
  );
}