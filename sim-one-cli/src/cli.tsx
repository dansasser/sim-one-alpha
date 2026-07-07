import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, Option } from 'commander';
import { render } from 'ink';
import React from 'react';
import { App } from './App.js';
import { ensureServerRunning, cleanupServer } from './launcher/server-manager.js';
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

interface ProductTuiOptions {
  port?: string;
  baseUrl?: string;
  session?: string;
  serverPath?: string;
  envPath?: string;
  smokeStartup?: boolean;
  ink?: boolean;
}

program
  .name('sim-one')
  .description('SIM-ONE Alpha — interactive TUI coding interface + capability management.')
  .option('--port <number>', 'server port (when launching TUI)')
  .option('--base-url <url>', 'full base url (overrides --port, when launching TUI)')
  .option('--session <id>', 'agent instance id (when launching TUI)')
  .addOption(new Option('--server-path <path>', 'built SIM-ONE Alpha server.mjs path').hideHelp())
  .addOption(new Option('--env-path <path>', 'env file path').hideHelp())
  .addOption(new Option('--smoke-startup', 'start/connect gateway then exit').hideHelp())
  .addOption(new Option('--ink', 'launch the legacy Ink TUI fallback').hideHelp())
  .action(async (opts: ProductTuiOptions) => {
    validateTuiOptions(opts);
    if (opts.ink) {
      await launchInkTui(opts);
      return;
    }
    await launchRatatuiTui(opts);
  });

function validateTuiOptions(opts: ProductTuiOptions): void {
  if (!opts.port) {
    return;
  }
  const port = parseInt(opts.port, 10);
  if (!port || port < 1 || port > 65535 || !/^\d+$/.test(opts.port)) {
    console.error(`Invalid port: ${opts.port}. Must be a number 1-65535.`);
    process.exit(1);
  }
}

async function launchRatatuiTui(opts: ProductTuiOptions): Promise<void> {
  const tuiPath = resolveRatatuiBinary();
  if (!existsSync(tuiPath)) {
    console.error(`Ratatui TUI not found at ${tuiPath}. Run 'pnpm run build:tui:ratatui' first.`);
    process.exit(1);
  }

  const child = spawn(tuiPath, ratatuiArgs(opts), {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });

  const exitCode = await waitForChild(child);
  process.exitCode = exitCode;
}

function ratatuiArgs(opts: ProductTuiOptions): string[] {
  const args: string[] = [];
  if (opts.port && !opts.baseUrl) args.push('--port', opts.port);
  if (opts.baseUrl) args.push('--base-url', opts.baseUrl);
  if (opts.session) args.push('--session', opts.session);
  if (opts.serverPath) args.push('--server-path', opts.serverPath);
  if (opts.envPath) args.push('--env-path', opts.envPath);
  if (opts.smokeStartup) args.push('--smoke-startup');
  return args;
}

function resolveRatatuiBinary(): string {
  if (process.env.SIM_ONE_TUI_PATH) {
    return resolve(process.env.SIM_ONE_TUI_PATH);
  }

  const binaryName = process.platform === 'win32' ? 'sim-one-ratatui-tui.exe' : 'sim-one-ratatui-tui';
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDir, '..', 'sim-one-ratatui', binaryName),
    resolve(process.cwd(), '.gorombo', 'sim-one-ratatui', binaryName),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function waitForChild(child: ChildProcess): Promise<number> {
  return new Promise((resolveExitCode, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolveExitCode(code ?? 1));
  });
}

async function launchInkTui(opts: ProductTuiOptions): Promise<void> {
  const session = opts.session ?? 'legacy-ink';

  if (opts.baseUrl) {
    const instance = render(<App baseUrl={opts.baseUrl} session={session} />, {
      exitOnCtrlC: true,
    });
    await instance.waitUntilExit();
    return;
  }

  const port = opts.port ? parseInt(opts.port, 10) : undefined;
  const result = await ensureServerRunning({ port });

  const baseUrl = result.baseUrl;
  const { started } = result;

  const instance = render(<App baseUrl={baseUrl} session={session} />, {
    exitOnCtrlC: true,
  });

  await instance.waitUntilExit();
  if (started) {
    try {
      await cleanupServer();
    } catch {
    }
  }
}

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

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
