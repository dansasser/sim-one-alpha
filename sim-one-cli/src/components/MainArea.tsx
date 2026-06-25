import { Box } from 'ink';
import React from 'react';

export interface MainAreaProps {
  children: React.ReactNode;
}

export function MainArea({ children }: MainAreaProps) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {children}
    </Box>
  );
}