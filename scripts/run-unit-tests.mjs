import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';

const forwardedArgs = process.argv.slice(2);
// pnpm can forward its "--" separator, as in "pnpm run test:unit -- --test-name-pattern ...".
if (forwardedArgs[0] === '--') {
  forwardedArgs.shift();
}

run(process.execPath, ['scripts/clean-tsc-output.mjs']);
run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']);
run(process.execPath, ['scripts/copy-runtime-config.mjs', '--tsc']);

const testFiles = globSync('.tmp/tsc/tests/*.test.js')
  .filter((p) => !p.endsWith('.skip.test.js'))
  .sort();

run(process.execPath, [
  '--test',
  '--test-force-exit',
  ...forwardedArgs,
  ...testFiles,
]);

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
