/**
 * Shared result-shape types for LSP-backed code-intelligence tools.
 *
 * Every LSP tool returns a value conforming to `LspToolResult<T>` so callers
 * (model or wrapper tools) can always tell:
 * - whether LSP was available
 * - which provider ultimately produced the data
 * - which language was detected
 * - what the canonical result payload is
 */

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspDocumentUri {
  uri: string;
}

export interface LspSymbolInformation {
  name: string;
  kind: number;
  location: LspLocation;
  containerName?: string;
}

export interface LspDocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}

export interface LspHover {
  contents:
    | string
    | { language: string; value: string }
    | Array<string | { language: string; value: string }>;
  range?: LspRange;
}

export type LspProvider = 'lsp' | 'ast' | 'grep' | 'none';

export interface LspToolResult<T> {
  provider: LspProvider;
  lspAvailable: boolean;
  languageId: string;
  result: T;
  fallbackReason?: string;
}

export interface LspDefinitionResult {
  definitions: LspLocation[];
}

export interface LspReferencesResult {
  references: LspLocation[];
}

export interface LspDocumentSymbolsResult {
  symbols: LspDocumentSymbol[];
}

export interface LspWorkspaceSymbolsResult {
  symbols: LspSymbolInformation[];
}

export interface LspHoverResult {
  hover: LspHover | null;
}

export interface LspPrepareRenameResult {
  range: LspRange | null;
  placeholder?: string;
}
