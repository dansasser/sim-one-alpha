import { Box, Text } from 'ink';
import React from 'react';

export interface AsideProps {
  children?: React.ReactNode;
}

export function Aside({ children }: AsideProps) {
  return (
    <Box flexDirection="column" width="20%" borderStyle="single" borderColor="gray">
      <Box paddingX={1}>
        <Text bold color="cyan">Tokens</Text>
      </Box>
      <Box paddingX={1}>
        <Text dimColor>— — — — —</Text>
      </Box>
      <Box paddingX={1}>
        <Text bold color="cyan">Todos</Text>
      </Box>
      <Box paddingX={1} flexGrow={1}>
        <Text dimColor>(no active tasks)</Text>
      </Box>
      <Box paddingX={1}>
        <Text bold color="cyan">Activity</Text>
      </Box>
      <Box paddingX={1} flexGrow={1}>
        <Text dimColor>(no events)</Text>
      </Box>
      <Box paddingX={1} borderStyle="single" borderTop>
        <Text bold>SIM-ONE Alpha</Text>
        <Text dimColor> v0.1</Text>
      </Box>
    </Box>
  );
}