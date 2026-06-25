import { Box, useStdout } from 'ink';
import React from 'react';

export interface OuterContainerProps {
  children: React.ReactNode;
}

export function OuterContainer({ children }: OuterContainerProps) {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;

  return (
    <Box height={rows} flexDirection="row">
      {children}
    </Box>
  );
}