import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';
import { App } from './App.js';

const program = new Command();

program
  .name('sim-one')
  .description('SIM-ONE Alpha — interactive TUI coding interface + capability management.')
  .option('--port <number>', 'server port (when launching TUI)', '3000')
  .option('--base-url <url>', 'full base url (overrides --port, when launching TUI)')
  .option('--session <id>', 'agent instance id (when launching TUI)', 'proto')
  .option('--token <secret>', 'API secret (defaults to API_SECRET env, when launching TUI)')
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

function createKindCommand(kind: string, description: string): Command {
  return new Command(kind)
    .description(description)
    .command('add <source> <id> <name>')
    .description(`Add a ${kind} from a GitHub URL or local directory path`)
    .option('--enable', `enable the ${kind} immediately`)
    .option('--description <text>', `${kind} description`)
    .option('--version <ver>', 'pin to a specific version or git ref')
    .action(() => {
      console.log(`sim-one ${kind} add — not yet implemented (Phase 2)`);
      process.exit(1);
    })
    .parent as Command;
}

function createKindCommandGroup(kind: string, description: string): Command {
  const group = new Command(kind).description(description);

  group
    .command('add <source> <id> <name>')
    .description(`Add a ${kind} from a GitHub URL or local directory path`)
    .option('--enable', `enable the ${kind} immediately`)
    .option('--description <text>', `${kind} description`)
    .option('--version <ver>', 'pin to a specific version or git ref')
    .action(() => {
      console.log(`sim-one ${kind} add — not yet implemented (Phase 2)`);
      process.exit(1);
    });

  group
    .command('list')
    .description(`List all ${kind} capabilities`)
    .action(() => {
      console.log(`sim-one ${kind} list — not yet implemented (Phase 2)`);
      process.exit(1);
    });

  group
    .command('enable <id>')
    .description(`Enable a ${kind} capability`)
    .action(() => {
      console.log(`sim-one ${kind} enable — not yet implemented (Phase 2)`);
      process.exit(1);
    });

  group
    .command('disable <id>')
    .description(`Disable a ${kind} capability`)
    .action(() => {
      console.log(`sim-one ${kind} disable — not yet implemented (Phase 2)`);
      process.exit(1);
    });

  group
    .command('remove <id>')
    .description(`Remove a ${kind} capability and delete its files`)
    .action(() => {
      console.log(`sim-one ${kind} remove — not yet implemented (Phase 2)`);
      process.exit(1);
    });

  group
    .command('update <id>')
    .description(`Re-fetch a ${kind} from its source`)
    .action(() => {
      console.log(`sim-one ${kind} update — not yet implemented (Phase 2)`);
      process.exit(1);
    });

  return group;
}

const skillCmd = createKindCommandGroup('skill', 'Manage skills');
const toolCmd = createKindCommandGroup('tool', 'Manage tools');
const workerCmd = createKindCommandGroup('worker', 'Manage workers (subagents)');

const mcpCmd = new Command('mcp').description('Manage MCP servers');
mcpCmd
  .command('add <id> <name>')
  .description('Add an MCP server connection')
  .option('--url <url>', 'MCP server endpoint URL')
  .option('--transport <type>', 'transport type (streamable-http or sse)', 'streamable-http')
  .option('--token-env <env>', 'environment variable name containing the auth token')
  .option('--enable', 'enable the MCP server immediately')
  .option('--description <text>', 'MCP server description')
  .action(() => {
    console.log('sim-one mcp add — not yet implemented (Phase 2)');
    process.exit(1);
  });
mcpCmd
  .command('list')
  .description('List all MCP server capabilities')
  .action(() => {
    console.log('sim-one mcp list — not yet implemented (Phase 2)');
    process.exit(1);
  });
mcpCmd
  .command('enable <id>')
  .description('Enable an MCP server capability')
  .action(() => {
    console.log('sim-one mcp enable — not yet implemented (Phase 2)');
    process.exit(1);
  });
mcpCmd
  .command('disable <id>')
  .description('Disable an MCP server capability')
  .action(() => {
    console.log('sim-one mcp disable — not yet implemented (Phase 2)');
    process.exit(1);
  });
mcpCmd
  .command('remove <id>')
  .description('Remove an MCP server capability')
  .action(() => {
    console.log('sim-one mcp remove — not yet implemented (Phase 2)');
    process.exit(1);
  });
mcpCmd
  .command('update <id>')
  .description('Update an MCP server configuration')
  .action(() => {
    console.log('sim-one mcp update — not yet implemented (Phase 2)');
    process.exit(1);
  });

program.addCommand(skillCmd);
program.addCommand(toolCmd);
program.addCommand(workerCmd);
program.addCommand(mcpCmd);

program.parse();