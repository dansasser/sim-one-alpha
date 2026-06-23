import { Box, Text } from 'ink';
import React from 'react';
import type { UIMessage, UIMessagePart } from '@flue/react';

export interface MessageViewProps {
  message: UIMessage;
}

const ROLE_COLOR: Record<string, string> = {
  user: 'cyan',
  assistant: 'green',
  system: 'gray',
};

const ROLE_LABEL: Record<string, string> = {
  user: 'you',
  assistant: 'assistant',
  system: 'system',
};

export function MessageView({ message }: MessageViewProps) {
  const color = ROLE_COLOR[message.role] ?? 'gray';
  const label = ROLE_LABEL[message.role] ?? message.role;

  const textParts = message.parts.filter(
    (part): part is Extract<UIMessagePart, { type: 'text' }> => part.type === 'text',
  );
  const reasoningParts = message.parts.filter(
    (part): part is Extract<UIMessagePart, { type: 'reasoning' }> => part.type === 'reasoning',
  );

  if (textParts.length === 0 && reasoningParts.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={color}>{label}:</Text>
      {reasoningParts.map((part, index) => (
        <Text key={`r-${index}`} dimColor italic wrap="wrap">
          {part.text}
        </Text>
      ))}
      {textParts.map((part, index) => (
        <Text key={`t-${index}`} wrap="wrap">
          {part.text}
        </Text>
      ))}
    </Box>
  );
}