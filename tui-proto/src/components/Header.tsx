import { Box, Text } from 'ink';
import React from 'react';

export interface HeaderProps {
  baseUrl: string;
  session: string;
  status: string;
}

const STATUS_COLOR: Record<string, string> = {
  idle: 'gray',
  connecting: 'yellow',
  submitted: 'cyan',
  streaming: 'green',
  error: 'red',
};

export function Header({ baseUrl, session, status }: HeaderProps) {
  const color = STATUS_COLOR[status] ?? 'gray';
  return (
    <Box borderStyle="round" borderColor="blue" paddingX={1} justifyContent="space-between">
      <Text bold color="cyan">SIM-ONE Alpha Proto</Text>
      <Text color="gray">{baseUrl}</Text>
      <Text color="gray">session: {session}</Text>
      <Text bold color={color}>{status}</Text>
    </Box>
  );
}