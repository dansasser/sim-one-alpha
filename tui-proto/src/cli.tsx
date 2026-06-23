import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';
import { App } from './App.js';

const program = new Command();

program
  .name('sim-one-alpha-tui-proto')
  .description('Interactive TUI prototype for testing the built SIM-ONE Alpha agent.')
  .option('--port <number>', 'server port', '3000')
  .option('--base-url <url>', 'full base url (overrides --port)')
  .option('--session <id>', 'agent instance id', 'proto')
  .option('--token <secret>', 'API secret (defaults to API_SECRET env)')
  .action((opts) => {
    const baseUrl = opts.baseUrl ?? `http://localhost:${opts.port}`;
    const token = opts.token ?? process.env.API_SECRET;
    if (!token) {
      console.error('API_SECRET required: pass --token <secret> or set API_SECRET in env.');
      process.exit(1);
    }

    const session = opts.session;
    render(<App baseUrl={baseUrl} session={session} token={token} />);
  });

program.parse();