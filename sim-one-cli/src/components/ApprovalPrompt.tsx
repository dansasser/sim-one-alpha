import { Box, Text } from 'ink';
import React, { useCallback, useRef } from 'react';
import { useInput } from 'ink';
import type { ApprovalClient, ApprovalRequest } from '../lib/approvalClient.js';

export interface ApprovalPromptProps {
  approval: ApprovalRequest;
  client: ApprovalClient;
  decidedBy: string;
  onResolved: () => void;
}

export function ApprovalPrompt({ approval, client, decidedBy, onResolved }: ApprovalPromptProps) {
  const [status, setStatus] = React.useState<'idle' | 'submitting' | 'done' | 'error'>('idle');
  const [message, setMessage] = React.useState<string>('');
  const submittingRef = useRef(false);

  const handleDecision = useCallback(
    async (approved: boolean) => {
      if (submittingRef.current) return;
      submittingRef.current = true;
      setStatus('submitting');
      try {
        await client.decide({
          requestId: approval.requestId,
          approved,
          decidedBy,
          reason: approved ? 'approved via TUI' : 'denied via TUI',
        });
        setStatus('done');
        setMessage(approved ? '✓ Approved' : '✗ Denied');
        setTimeout(onResolved, 500);
      } catch (err) {
        setStatus('error');
        setMessage(err instanceof Error ? err.message : String(err));
      } finally {
        submittingRef.current = false;
      }
    },
    [approval, client, decidedBy, onResolved],
  );

  useInput(
    (input) => {
      if (status === 'submitting' || status === 'done') return;
      if (input === 'y' || input === 'Y') {
        handleDecision(true);
      } else if (input === 'n' || input === 'N') {
        handleDecision(false);
      }
    },
    { isActive: status === 'idle' || status === 'error' },
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
      <Text bold color="yellow">⚠ APPROVAL REQUESTED</Text>
      <Text color="white">{approval.taskType}: {approval.description}</Text>
      <Text dimColor>id: {approval.requestId}</Text>
      {status === 'idle' && (
        <Box marginTop={1}>
          <Text color="green" bold>[y]</Text>
          <Text> approve  </Text>
          <Text color="red" bold>[n]</Text>
          <Text> deny</Text>
        </Box>
      )}
      {status === 'submitting' && <Text color="cyan">submitting…</Text>}
      {status === 'done' && <Text color={message.startsWith('✓') ? 'green' : 'red'} bold>{message}</Text>}
      {status === 'error' && (
        <Box flexDirection="column">
          <Text color="red">error: {message}</Text>
          <Text dimColor>press [y] to retry approve, [n] to retry deny</Text>
        </Box>
      )}
    </Box>
  );
}