import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';
import { App } from './App.js';
import { ensureServerRunning, setServerChild, cleanupServer } from './launcher/server-manager.js';
import {
  addSkill,
  listSkills,
  enableSkill,
  disableSkill,
  removeSkill,
  updateSkill,
  addTool,
  listTools,
  enableTool,
  disableTool,
  removeTool,
  updateTool,
  addWorker,
  listWorkers,
  enableWorker,
  disableWorker,
  removeWorker,
  updateWorker,
  addMcp,
  listMcp,
  enableMcp,
  disableMcp,
  removeMcp,
  updateMcp,
} from './commands/index.js';

const program = new Command();

program
  .name('sim-one')
  .description('SIM-ONE Alpha — interactive TUI coding interface + capability management.')
  .option('--port <number>', 'server port (when launching TUI)')
  .option('--base-url <url>', 'full base url (overrides --port, when launching TUI)')
  .option('--session <id>', 'agent instance id (when launching TUI)', 'proto')
  .action(async (opts) => {
    const session = opts.session;

    if (opts.baseUrl) {
      const instance = render(<App baseUrl={opts.baseUrl} session={session} />, {
        exitOnCtrlC: true,
      });
      instance.waitUntilExit().then(() => process.exit(0));
      return;
    }

    const port = opts.port ? parseInt(opts.port, 10) : undefined;
    if (opts.port && (!port || port < 1 || port > 65535 || !/^\d+$/.test(opts.port))) {
      console.error(`Invalid port: ${opts.port}. Must be a number 1-65535.`);
      process.exit(1);
    }
    const result = await ensureServerRunning({ port });

    const baseUrl = result.baseUrl;
    const { started } = result;

    const instance = render(<App baseUrl={baseUrl} session={session} />, {
      exitOnCtrlC: true,
    });

    instance.waitUntilExit().then(async () => {
      if (started) {
        try {
          await cleanupServer();
        } catch {
        }
      }
      process.exit(0);
    });
  });

function addKindCommands(program: Command, kind: 'skill' | 'tool' | 'worker'): void {
  const fns = {
    skill: { add: addSkill, list: listSkills, enable: enableSkill, disable: disableSkill, remove: removeSkill, update: updateSkill },
    tool: { add: addTool, list: listTools, enable: enableTool, disable: disableTool, remove: removeTool, update: updateTool },
    worker: { add: addWorker, list: listWorkers, enable: enableWorker, disable: disableWorker, remove: removeWorker, update: updateWorker },
  }[kind];

  const cmd = program.command(kind).description(`Manage ${kind}s${kind === 'worker' ? ' (subagents)' : ''}`);

  cmd
    .command('add <source> <id> <name>')
    .description(`Add a ${kind} from a GitHub URL or local directory path`)
    .option('--description <text>', `${kind} description`)
    .option('--enable', `enable the ${kind} immediately`)
    .option('--version <ver>', 'pin to a specific version or git ref')
    .action((source: string, id: string, name: string, opts: { description?: string; enable?: boolean; version?: string }) => {
      fns.add(source, id, name, opts.description ?? '', kind === 'skill' ? (opts.enable ?? true) : (opts.enable ?? false), opts.version);
    });

  cmd.command('list').description(`List all ${kind} capabilities`).action(() => fns.list());

  cmd.command('enable <id>').description(`Enable a ${kind} capability`).action((id: string) => fns.enable(id));

  cmd.command('disable <id>').description(`Disable a ${kind} capability`).action((id: string) => fns.disable(id));

  cmd.command('remove <id>').description(`Remove a ${kind} capability and delete its files`).action((id: string) => fns.remove(id));

  cmd.command('update <id>').description(`Re-fetch a ${kind} from its source`).action((id: string) => fns.update(id));
}

addKindCommands(program, 'skill');
addKindCommands(program, 'tool');
addKindCommands(program, 'worker');

const mcpCmd = program.command('mcp').description('Manage MCP servers');

mcpCmd
  .command('add <id> <name>')
  .description('Add an MCP server connection')
  .option('--url <url>', 'MCP server endpoint URL')
  .option('--transport <type>', 'transport type (streamable-http or sse)', 'streamable-http')
  .option('--token-env <env>', 'environment variable name containing the auth token')
  .option('--description <text>', 'MCP server description')
  .option('--enable', 'enable the MCP server immediately')
  .action((id: string, name: string, opts: { url?: string; transport?: 'streamable-http' | 'sse'; tokenEnv?: string; description?: string; enable?: boolean }) => {
    if (!opts.url) {
      console.error('Error: --url is required for mcp add');
      process.exit(1);
    }
    addMcp(id, name, opts.url, opts.description ?? '', opts.transport ?? 'streamable-http', opts.tokenEnv, opts.enable ?? false);
  });

mcpCmd.command('list').description('List all MCP server capabilities').action(() => listMcp());
mcpCmd.command('enable <id>').description('Enable an MCP server capability').action((id: string) => enableMcp(id));
mcpCmd.command('disable <id>').description('Disable an MCP server capability').action((id: string) => disableMcp(id));
mcpCmd.command('remove <id>').description('Remove an MCP server capability').action((id: string) => removeMcp(id));
mcpCmd.command('update <id>').description('Update an MCP server configuration').action((id: string) => updateMcp(id));

program.parse();