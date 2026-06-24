import { Box } from 'ink';
import React from 'react';
import type { UIMessage } from '@flue/react';
import { MessageView } from './MessageView.js';

export interface MessageListProps {
  messages: UIMessage[];
}

export function MessageList({ messages }: MessageListProps) {
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1} overflowY="hidden">
      {messages.map((message) => (
        <MessageView key={message.id} message={message} />
      ))}
    </Box>
  );
}