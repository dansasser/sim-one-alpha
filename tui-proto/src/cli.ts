import { Command } from 'commander';

const program = new Command();

program
  .name('sim-one-alpha-tui-proto')
  .description('Interactive TUI prototype for testing the built SIM-ONE Alpha agent.')
  .option('--port <number>', 'server port', '3000')
  .option('--base-url <url>', 'full base url (overrides --port)')
  .option('--session <id>', 'agent instance id', 'proto')
  .option('--token <secret>', 'API secret (defaults to API_SECRET env)')
  .action((_opts) => {
    // Phase 1 will wire up the Ink render here.
    console.error('TUI not yet implemented — see plans/agent-tui-proto/implementation.md');
    process.exit(1);
  });

program.parse();