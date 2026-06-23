import { useFlueAgent } from '@flue/react';
import { Box, Text } from 'ink';
import React, { useMemo, useState } from 'react';
import { Header } from './Header.js';
import { MessageList } from './MessageList.js';
import { ChatInput } from './ChatInput.js';
import { StatusLine } from './StatusLine.js';
import { ApprovalList } from './ApprovalList.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';
import { createApprovalClient } from '../lib/approvalClient.js';
import { usePendingApprovals } from '../hooks/usePendingApprovals.js';

export interface ChatLayoutProps {
  baseUrl: string;
  session: string;
  token: string;
  decidedBy: string;
}

export function ChatLayout({ baseUrl, session, token, decidedBy }: ChatLayoutProps) {
  const agent = useFlueAgent({ name: 'orchestrator', id: session });
  const [input, setInput] = useState('');

  const approvalClient = useMemo(
    () => createApprovalClient(baseUrl, token),
    [baseUrl, token],
  );

  const { pending, configured } = usePendingApprovals(approvalClient);
  const [activeApprovalId, setActiveApprovalId] = useState<string | undefined>();

  const activeApproval = pending.find((p) => p.requestId === activeApprovalId) ?? pending[pending.length - 1];
  const hasActiveApproval = Boolean(activeApproval);

  const handleSubmit = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || agent.status === 'streaming' || agent.status === 'submitted') return;
    setInput('');
    try {
      await agent.sendMessage(trimmed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('sendMessage failed:', message);
    }
  };

  const inputDisabled =
    agent.status === 'streaming' ||
    agent.status === 'submitted' ||
    hasActiveApproval;

  return (
    <Box flexDirection="column" height="100%">
      <Header baseUrl={baseUrl} session={session} status={agent.status} />
      <MessageList messages={agent.messages} />
      {!configured && (
        <Box paddingX={1}>
          <Text dimColor>approvals: not configured (set GOROMBO_APPROVAL_ROOT on the server)</Text>
        </Box>
      )}
      {configured && pending.length > 0 && !hasActiveApproval && (
        <ApprovalList pending={pending} />
      )}
      {configured && activeApproval && (
        <ApprovalPrompt
          approval={activeApproval}
          client={approvalClient}
          decidedBy={decidedBy}
          onResolved={() => setActiveApprovalId(undefined)}
        />
      )}
      <StatusLine status={agent.status} error={agent.error} />
      <ChatInput
        value={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        disabled={inputDisabled}
      />
    </Box>
  );
}