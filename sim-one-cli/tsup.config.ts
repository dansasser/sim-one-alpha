import { defineConfig, type Options } from 'tsup';
import { readFileSync, writeFileSync } from 'node:fs';
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
    const outPath = resolve(__dirname, '..', '.gorombo', 'sim-one-cli', 'cli.js');
    let content = readFileSync(outPath, 'utf8');
    content = content.replace(/from\s+["']sqlite["']/g, 'from "node:sqlite"');
    writeFileSync(outPath, content);
  },
  loader: { '.tsx': 'tsx' },
} as Options);