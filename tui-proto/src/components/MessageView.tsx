import { Box, Text } from 'ink';
import React from 'react';
import type { UIMessage, UIMessagePart } from '@flue/react';
import { ToolCallView } from './ToolCallView.js';
import { SubagentView } from './SubagentView.js';

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

type DynamicToolPart = Extract<UIMessagePart, { type: 'dynamic-tool' }>;

function isToolPart(part: UIMessagePart): part is DynamicToolPart {
  return part.type === 'dynamic-tool';
}

function isSubagentDelegation(part: DynamicToolPart): boolean {
  if (part.toolName !== 'task') return false;
  if (typeof part.input !== 'object' || part.input === null) return false;
  return 'agent' in part.input;
}

function getAgentName(part: DynamicToolPart): string {
  const input = part.input as Record<string, unknown>;
  return typeof input.agent === 'string' ? input.agent : 'unknown';
}

export function MessageView({ message }: MessageViewProps) {
  const color = ROLE_COLOR[message.role] ?? 'gray';
  const label = ROLE_LABEL[message.role] ?? message.role;

  if (message.parts.length === 0) return null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={color}>{label}:</Text>
      {message.parts.map((part, index) => {
        if (part.type === 'text') {
          return (
            <Text key={`t-${index}`} wrap="wrap">
              {part.text}
            </Text>
          );
        }

        if (part.type === 'reasoning') {
          return (
            <Text key={`r-${index}`} dimColor italic wrap="wrap">
              {part.text}
            </Text>
          );
        }

        if (part.type === 'file') {
          return (
            <Text key={`f-${index}`} dimColor>
              [file: {part.mediaType}]
            </Text>
          );
        }

        if (isToolPart(part)) {
          if (isSubagentDelegation(part)) {
            return (
              <SubagentView
                key={`s-${index}`}
                toolCallId={part.toolCallId}
                agentName={getAgentName(part)}
                state={part.state}
                input={part.input}
                output={part.state === 'output-available' ? part.output : undefined}
                errorText={part.state === 'output-error' ? part.errorText : undefined}
              />
            );
          }

          return (
            <ToolCallView
              key={`c-${index}`}
              toolName={part.toolName}
              toolCallId={part.toolCallId}
              state={part.state}
              input={part.input}
              output={part.state === 'output-available' ? part.output : undefined}
              errorText={part.state === 'output-error' ? part.errorText : undefined}
            />
          );
        }

        return null;
      })}
    </Box>
  );
}