# Adding a New Language Server

This guide explains how to add support for a new language server to the coding worker's LSP gateway.

## Where things live

- `src/workers/coding-worker/tools/code-intelligence/lsp/lsp-server-registry.ts` — maps language ids and file extensions to server commands.
- `src/workers/coding-worker/tools/code-intelligence/lsp/lsp-project-config.ts` — detects the project root for a file/language.
- `src/workers/coding-worker/tools/code-intelligence/lsp/lsp-tools.ts` — defines the model-callable `lsp_*` tools and result normalization.
- `src/workers/coding-worker/tools/code-intelligence/code-intelligence-tools.ts` — wrapper tools (`coding_symbol_navigate`, etc.) that prefer LSP and fall back to AST.
- `src/tests/lsp-tools.test.ts` — unit tests with mocked JSON-RPC responses.
- `src/tests/lsp-integration.test.ts` — real-server integration tests (run only when `GOROMBO_LSP_REAL_SERVER_TESTS=1`).
- `src/tests/fixtures/<language>/` — fixture projects for integration tests.

## Steps

### 1. Register the language server

Open `lsp-server-registry.ts` and add an entry to `defaultServerCommands`. For example, to add Go support:

```ts
const defaultServerCommands: Record<string, LanguageServerCommand> = {
  // ... existing entries ...
  go: {
    languageId: 'go',
    fileExtensions: ['.go'],
    command: 'gopls',
    args: ['--stdio'],
  },
};
```

Add the file extension to the `extensionToLanguageId` map as well:

```ts
const extensionToLanguageId = (extension: string): string | undefined => {
  const map: Record<string, string> = {
    // ... existing entries ...
    '.go': 'go',
  };
  return map[extension.toLowerCase()];
};
```

### 2. Detect the project root

Open `lsp-project-config.ts` and add markers for the new language:

```ts
const languageMarkers: Record<string, string[]> = {
  // ... existing entries ...
  go: ['go.mod', 'go.sum'],
  default: ['package.json', 'pyproject.toml', 'go.mod'],
};
```

If the server needs extra options based on project files, extend `buildServerOptions`:

```ts
if (languageId === 'go') {
  return {
    buildAllowModfile: existsSync(join(projectRoot, 'go.mod')),
  };
}
```

### 3. Verify tool coverage

The existing `lsp_*` tools are language-agnostic. They will automatically route `.go` files to `gopls` once steps 1 and 2 are done. If the language server has special capabilities that need a new tool shape, add a new tool in `lsp-tools.ts` and export it through `createLspTools`.

### 4. Wire wrapper fallback (if needed)

The wrapper tools in `code-intelligence-tools.ts` already attempt LSP first for any supported language and fall back to the custom AST parsers. If you add a custom AST parser for the new language, make sure `supportedSourceExtensions` in `code-intelligence-tools.ts` includes the new extension so the AST path can activate when LSP is unavailable.

### 5. Add unit tests

In `src/tests/lsp-tools.test.ts`, add a mocked test case for the new language. Use `createMockClientFactory` to avoid spawning a real server. Assert the normalized result shape: `provider`, `lspAvailable`, `languageId`, and the payload.

### 6. Add integration tests and fixtures

1. Create a minimal fixture project under `src/tests/fixtures/lsp-go/`.
2. Add a test to `src/tests/lsp-integration.test.ts` that checks for `process.env.GOROMBO_LSP_REAL_SERVER_TESTS` and uses `LspLanguageServerRegistry` to skip gracefully when the server is not installed.

### 7. Run verification

```bash
export NVM_DIR="/root/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && nvm use 22
pnpm run typecheck
pnpm run test:unit
```

## Result-shape contract

Every LSP tool returns a value matching `LspToolResult<T>`:

```ts
{
  provider: 'lsp' | 'ast' | 'grep' | 'none',
  lspAvailable: boolean,
  languageId: string,
  result: T,
  fallbackReason?: string,
}
```

Keep this contract in mind when writing tests or consuming tool output in agents.

## Notes

- `lsp-client-manager.ts` handles process lifecycle: lazy start, idle shutdown, crash detection. You usually do not need to touch it when adding a language.
- If a server is not installed, the registry returns `undefined`, and the tool returns `{ provider: 'none', lspAvailable: false }`. The wrapper then falls back to AST/grep.
