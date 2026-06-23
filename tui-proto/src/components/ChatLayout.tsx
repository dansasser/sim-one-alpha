import { useFlueAgent } from '@flue/react';
import { Box } from 'ink';
import React, { useState } from 'react';
import { Header } from './Header.js';
import { MessageList } from './MessageList.js';
import { ChatInput } from './ChatInput.js';
import { StatusLine } from './StatusLine.js';

export interface ChatLayoutProps {
  baseUrl: string;
  session: string;
}

export function ChatLayout({ baseUrl, session }: ChatLayoutProps) {
  const agent = useFlueAgent({ name: 'orchestrator', id: session });
  const [input, setInput] = useState('');

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

  return (
    <Box flexDirection="column" height="100%">
      <Header baseUrl={baseUrl} session={session} status={agent.status} />
      <MessageList messages={agent.messages} />
      <StatusLine status={agent.status} error={agent.error} />
      <ChatInput
        value={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        disabled={agent.status === 'streaming' || agent.status === 'submitted'}
      />
    </Box>
  );
}