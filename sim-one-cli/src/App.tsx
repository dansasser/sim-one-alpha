import { FlueProvider } from '@flue/react';
import { createFlueClient } from '@flue/sdk';
import React, { useMemo } from 'react';
import { ChatLayout } from './components/ChatLayout.js';

export interface AppProps {
  baseUrl: string;
  session: string;
}

export function App({ baseUrl, session }: AppProps) {
  const client = useMemo(
    () => createFlueClient({ baseUrl }),
    [baseUrl],
  );

  return (
    <FlueProvider client={client}>
      <ChatLayout baseUrl={baseUrl} session={session} decidedBy={session} />
    </FlueProvider>
  );
}