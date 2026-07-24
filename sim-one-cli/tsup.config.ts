import { defineConfig, type Options } from 'tsup';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const emptyShim = {
  name: 'empty-shim',
  setup(build: any) {
    build.onResolve({ filter: /^react-devtools-core$/ }, (args: any) => ({
      path: args.path,
      namespace: 'empty-shim',
    }));
    build.onLoad({ filter: /.*/, namespace: 'empty-shim' }, () => ({
      contents: 'export default undefined;',
      loader: 'js',
    }));
  },
};

export default defineConfig({
  entry: ['src/cli.tsx'],
  format: ['esm'],
  outDir: '../.gorombo/sim-one-cli',
  target: 'node22',
  platform: 'node',
  splitting: false,
  sourcemap: false,
  clean: true,
  noExternal: [
    '@flue/sdk',
    '@flue/react',
    'ink',
    'ink-spinner',
    'ink-text-input',
    'react',
    'react/jsx-runtime',
    'commander',
  ],
  esbuildPlugins: [emptyShim],
  esbuildOptions(options) {
    options.banner = {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    };
  },
  async onSuccess() {
    const outDir = resolve(__dirname, '..', '.gorombo', 'sim-one-cli');
    const outPath = resolve(outDir, 'cli.js');
    let content = readFileSync(outPath, 'utf8');
    content = content.replace(/from\s+["']sqlite["']/g, 'from "node:sqlite"');
    writeFileSync(outPath, content);
    writeProductLaunchers(outDir);
  },
  loader: { '.tsx': 'tsx' },
} as Options);

function writeProductLaunchers(outDir: string): void {
  const posixPath = resolve(outDir, 'sim-one');
  writeFileSync(
    posixPath,
    [
      '#!/usr/bin/env sh',
      'set -e',
      'DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
      'if [ -n "$SIM_ONE_NODE" ]; then',
      '  exec "$SIM_ONE_NODE" "$DIR/cli.js" "$@"',
      'fi',
      'exec node "$DIR/cli.js" "$@"',
      '',
    ].join('\n'),
  );
  chmodSync(posixPath, 0o755);

  writeFileSync(
    resolve(outDir, 'sim-one.cmd'),
    [
      '@echo off',
      'setlocal',
      'if defined SIM_ONE_NODE (',
      '  "%SIM_ONE_NODE%" "%~dp0\\cli.js" %*',
      ') else (',
      '  node "%~dp0\\cli.js" %*',
      ')',
      '',
    ].join('\r\n'),
  );
}
