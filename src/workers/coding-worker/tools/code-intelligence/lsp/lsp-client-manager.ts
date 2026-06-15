import { spawn } from 'node:child_process';
import { LspLanguageServerRegistry, type LanguageServerCommand } from './lsp-server-registry.js';
import { JsonRpcClient } from './lsp-json-rpc.js';
import { detectProjectConfig, type LspProjectConfig } from './lsp-project-config.js';

export interface LspClientManagerOptions {
  workspaceRoot: string;
  registry?: LspLanguageServerRegistry;
  idleShutdownMs?: number;
  onServerLog?: (languageId: string, message: string) => void;
  onInitializing?: (languageId: string, projectRoot: string) => void;
  /**
   * Test-only override for the JSON-RPC client factory. When provided, the
   * manager skips spawning a real language server and uses this factory instead.
   */
  createJsonRpcClient?: (context: LspRequestContext) => JsonRpcClient;
}

export interface LspClient {
  languageId: string;
  projectRoot: string;
  client: JsonRpcClient;
  initialized: boolean;
  lastUsedAt: number;
}

export interface LspRequestContext {
  workspaceRoot: string;
  filePath: string;
  languageId: string;
  projectRoot: string;
}

export class LspClientManager {
  private readonly registry: LspLanguageServerRegistry;
  private readonly clients = new Map<string, LspClient>();
  private readonly idleShutdownMs: number;
  private readonly onServerLog?: (languageId: string, message: string) => void;
  private readonly onInitializing?: (languageId: string, projectRoot: string) => void;
  private readonly createJsonRpcClient?: (context: LspRequestContext) => JsonRpcClient;
  private shutdownTimer: NodeJS.Timeout | undefined;
  private readonly openDocuments = new Set<string>();

  constructor(private readonly options: LspClientManagerOptions) {
    this.registry = options.registry ?? new LspLanguageServerRegistry();
    this.idleShutdownMs = options.idleShutdownMs ?? 10 * 60 * 1000;
    this.onServerLog = options.onServerLog;
    this.onInitializing = options.onInitializing;
    this.createJsonRpcClient = options.createJsonRpcClient;
  }

  async request(context: LspRequestContext, method: string, params: unknown): Promise<unknown> {
    const client = await this.getOrCreateClient(context);
    if (!client) {
      return { lspAvailable: false, reason: `No language server available for ${context.languageId}.` };
    }

    client.lastUsedAt = Date.now();
    this.scheduleIdleShutdown();

    if (!client.initialized) {
      await this.initializeClient(client);
    }

    return client.client.request(method, params);
  }

  async initializeClient(client: LspClient): Promise<void> {
    if (client.initialized) {
      return;
    }

    this.onInitializing?.(client.languageId, client.projectRoot);

    await client.client.request('initialize', {
      processId: process.pid,
      rootUri: pathToUri(client.projectRoot),
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false },
          completion: { dynamicRegistration: false },
          hover: { dynamicRegistration: false },
          definition: { dynamicRegistration: false, linkSupport: true },
          documentSymbol: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          rename: { dynamicRegistration: false, prepareSupport: true },
        },
        workspace: {
          workspaceFolders: false,
          symbol: { dynamicRegistration: false },
        },
      },
      workspaceFolders: null,
    });

    client.client.notify('initialized', {});
    client.initialized = true;
  }

  async openDocument(filePath: string, languageId: string, content: string): Promise<void> {
    const projectConfig = detectProjectConfig({
      workspaceRoot: this.options.workspaceRoot,
      filePath,
      languageId,
    });

    const context: LspRequestContext = {
      workspaceRoot: this.options.workspaceRoot,
      filePath,
      languageId,
      projectRoot: projectConfig.projectRoot,
    };

    const client = await this.getOrCreateClient(context);
    if (!client) {
      return;
    }

    if (!client.initialized) {
      await this.initializeClient(client);
    }

    const uri = pathToUri(filePath);
    if (this.openDocuments.has(uri)) {
      return;
    }
    this.openDocuments.add(uri);

    client.client.notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: client.languageId,
        version: 1,
        text: content,
      },
    });
  }

  async close(): Promise<void> {
    for (const client of this.clients.values()) {
      if (client.initialized) {
        try {
          await client.client.request('shutdown', {});
        } catch {
          // Ignore shutdown errors.
        }
      }
      try {
        client.client.notify('exit', {});
      } catch {
        // Ignore exit errors.
      }
      client.client.dispose();
    }
    this.clients.clear();
    if (this.shutdownTimer) {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = undefined;
    }
  }

  private async getOrCreateClient(context: LspRequestContext): Promise<LspClient | undefined> {
    const key = `${context.languageId}:${context.projectRoot}`;
    const existing = this.clients.get(key);
    if (existing) {
      return existing;
    }

    if (this.createJsonRpcClient) {
      const client = this.createJsonRpcClient(context);
      client.onServerLog = (message) => this.onServerLog?.(context.languageId, message);
      const lspClient: LspClient = {
        languageId: context.languageId,
        projectRoot: context.projectRoot,
        client,
        initialized: false,
        lastUsedAt: Date.now(),
      };
      this.clients.set(key, lspClient);
      this.scheduleIdleShutdown();
      return lspClient;
    }

    const command = await this.registry.resolve(context.languageId);
    if (!command) {
      return undefined;
    }

    const child = spawn(command.command, command.args, {
      cwd: context.projectRoot,
      env: { ...process.env, ...(command.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    if (!child.pid) {
      return undefined;
    }

    const client = new JsonRpcClient(child);
    client.onServerLog = (message) => this.onServerLog?.(context.languageId, message);

    const lspClient: LspClient = {
      languageId: context.languageId,
      projectRoot: context.projectRoot,
      client,
      initialized: false,
      lastUsedAt: Date.now(),
    };

    this.clients.set(key, lspClient);
    this.scheduleIdleShutdown();
    return lspClient;
  }

  private scheduleIdleShutdown(): void {
    if (this.shutdownTimer) {
      clearTimeout(this.shutdownTimer);
    }

    this.shutdownTimer = setTimeout(() => {
      const now = Date.now();
      for (const [key, client] of this.clients.entries()) {
        if (now - client.lastUsedAt > this.idleShutdownMs) {
          client.client.dispose();
          this.clients.delete(key);
        }
      }
    }, this.idleShutdownMs);
    this.shutdownTimer.unref();
  }
}

import { pathToFileURL } from 'node:url';

function pathToUri(filePath: string): string {
  return pathToFileURL(filePath).href;
}
