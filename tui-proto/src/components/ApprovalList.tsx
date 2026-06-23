import { Box, Text } from 'ink';
import React from 'react';
import type { ApprovalRequest } from '../lib/approvalClient.js';

export interface ApprovalListProps {
  pending: ApprovalRequest[];
}

export function ApprovalList({ pending }: ApprovalListProps) {
  if (pending.length === 0) return null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="yellow">⚠ Pending Approvals ({pending.length}):</Text>
      {pending.map((req, index) => (
        <Box key={req.requestId} flexDirection="column" marginLeft={2}>
          <Text color="yellow">
            {index + 1}. {req.taskType}: {req.description}
          </Text>
          <Text dimColor>   id: {req.requestId}</Text>
        </Box>
      ))}
    </Box>
  );
}