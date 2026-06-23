import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import React from 'react';

export interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled: boolean;
}

export function ChatInput({ value, onChange, onSubmit, disabled }: ChatInputProps) {
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1}>
      <Text color="green" bold>{'❯ '}</Text>
      {disabled ? (
        <Text color="gray" italic>waiting for agent…</Text>
      ) : (
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder="Type a message and press Enter…"
        />
      )}
    </Box>
  );
}