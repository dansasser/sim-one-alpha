import { useFlueAgent } from '@flue/react';
import { Box, Text } from 'ink';
import React, { useMemo, useState } from 'react';
import { OuterContainer } from './OuterContainer.js';
import { Aside } from './Aside.js';
import { MainArea } from './MainArea.js';
import { InputOutputSection } from './InputOutputSection.js';
import { BottomSection } from './BottomSection.js';
import { createApprovalClient } from '../lib/approvalClient.js';
import { usePendingApprovals } from '../hooks/usePendingApprovals.js';
import { ApprovalList } from './ApprovalList.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';

export interface ChatLayoutProps {
  baseUrl: string;
  session: string;
  decidedBy: string;
}

export function ChatLayout({ baseUrl, session, decidedBy }: ChatLayoutProps) {
  const agent = useFlueAgent({ name: 'orchestrator', id: session });
  const [input, setInput] = useState('');

  const approvalClient = useMemo(
    () => createApprovalClient(baseUrl),
    [baseUrl],
  );

  const { pending, configured } = usePendingApprovals(approvalClient);
  const [activeApprovalId, setActiveApprovalId] = useState<string | undefined>();

  const activeApproval = pending.find((p) => p.requestId === activeApprovalId);
  const hasActiveApproval = Boolean(activeApproval);

  const handleSubmit = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || agent.status === 'streaming' || agent.status === 'submitted') return;
    try {
      await agent.sendMessage(trimmed);
      setInput('');
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
    <OuterContainer>
      <Aside />
      <MainArea>
        <InputOutputSection messages={agent.messages} />
        {configured && pending.length > 0 && !hasActiveApproval && (
          <ApprovalList pending={pending} />
        )}
        {configured && activeApproval && (
          <ApprovalPrompt
            key={activeApproval.requestId}
            approval={activeApproval}
            client={approvalClient}
            decidedBy={decidedBy}
            onResolved={() => setActiveApprovalId(undefined)}
          />
        )}
        <BottomSection
          inputValue={input}
          onInputChange={setInput}
          onSubmit={handleSubmit}
          agentStatus={agent.status}
          messageCount={agent.messages.length}
          inputDisabled={inputDisabled}
        />
      </MainArea>
    </OuterContainer>
  );
}