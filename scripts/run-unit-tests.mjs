import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';

const forwardedArgs = process.argv.slice(2);
// pnpm can forward its "--" separator, as in "pnpm run test:unit -- --test-name-pattern ...".
if (forwardedArgs[0] === '--') {
  forwardedArgs.shift();
}

const hasTestFileArgs = forwardedArgs.some((arg) =>
  typeof arg === 'string' && arg.endsWith('.test.js'),
);

run(process.execPath, ['scripts/clean-tsc-output.mjs']);
run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']);
run(process.execPath, ['scripts/copy-runtime-config.mjs', '--tsc']);

const testFiles = hasTestFileArgs
  ? []
  : globSync('.tmp/tsc/tests/*.test.js')
      .filter((p) => !p.endsWith('.skip.test.js'))
      .sort();

run(process.execPath, [
  '--test',
  '--test-force-exit',
  // Cap parallel test files so spawn-heavy suites (coding-worker git/exec
  // subprocesses) can't exhaust CI runner memory and fail later spawns with
  // ENOMEM. 2 keeps the single spawn-heavy file from ever running alongside
  // more than one other file. Tunable if the runner budget changes.
  '--test-concurrency=2',
  ...forwardedArgs,
  ...testFiles,
]);

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, GOROMBO_TEST_MODE: '1' },
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
