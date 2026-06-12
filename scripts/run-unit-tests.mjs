import { spawnSync } from 'node:child_process';

const forwardedArgs = process.argv.slice(2);
if (forwardedArgs[0] === '--') {
  forwardedArgs.shift();
}

run(process.execPath, ['scripts/clean-tsc-output.mjs']);
run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']);
run(process.execPath, ['scripts/copy-runtime-config.mjs', '--tsc']);
run(process.execPath, ['--test', ...forwardedArgs, '.tmp/tsc/tests/*.test.js']);

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }

  if (result.signal) {
    throw new Error(`${command} exited from signal ${result.signal}`);
  }
}
