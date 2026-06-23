import { FlueProvider } from '@flue/react';
import { createFlueClient } from '@flue/sdk';
import React, { useMemo } from 'react';
import { ChatLayout } from './components/ChatLayout.js';

export interface AppProps {
  baseUrl: string;
  session: string;
  token: string;
}

export function App({ baseUrl, session, token }: AppProps) {
  const client = useMemo(
    () => createFlueClient({ baseUrl, headers: { 'x-api-secret': token } }),
    [baseUrl, token],
  );

  return (
    <FlueProvider client={client}>
      <ChatLayout baseUrl={baseUrl} session={session} token={token} decidedBy={session} />
    </FlueProvider>
  );
}