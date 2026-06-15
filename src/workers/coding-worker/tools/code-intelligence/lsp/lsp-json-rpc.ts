import type { ChildProcess } from 'node:child_process';

let nextRequestId = 1;

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class JsonRpcClient {
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private buffer = '';

  constructor(private readonly process: ChildProcess) {
    this.process.stdout?.on('data', (chunk: Buffer) => this.onData(chunk.toString('utf8')));
    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text.length > 0) {
        this.onServerLog?.(text);
      }
    });
    this.process.on('error', (error) => this.rejectAll(error));
    this.process.on('close', () => this.rejectAll(new Error('LSP server process closed')));
  }

  onServerLog?: (message: string) => void;

  request(method: string, params: unknown): Promise<unknown> {
    if (!this.process.stdin || this.process.killed) {
      return Promise.reject(new Error('LSP server process is not running'));
    }

    const id = nextRequestId++;
    const message: JsonRpcMessage = { jsonrpc: '2.0', id, method, params };
    const payload = JSON.stringify(message);
    const headers = `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n`;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process.stdin!.write(headers + payload, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.process.stdin || this.process.killed) {
      return;
    }

    const message: JsonRpcMessage = { jsonrpc: '2.0', method, params };
    const payload = JSON.stringify(message);
    const headers = `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n`;
    this.process.stdin.write(headers + payload);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;

    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }

      const headers = this.buffer.slice(0, headerEnd);
      const contentLengthMatch = /Content-Length:\s*(\d+)/i.exec(headers);
      if (!contentLengthMatch) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = Number(contentLengthMatch[1]);
      const messageStart = headerEnd + 4;
      if (this.buffer.length < messageStart + contentLength) {
        return;
      }

      const raw = this.buffer.slice(messageStart, messageStart + contentLength);
      this.buffer = this.buffer.slice(messageStart + contentLength);

      try {
        const message = JSON.parse(raw) as JsonRpcMessage;
        this.handleMessage(message);
      } catch {
        // Ignore malformed messages.
      }
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (message.id === undefined) {
      return;
    }

    const pending = this.pending.get(Number(message.id));
    if (!pending) {
      return;
    }

    this.pending.delete(Number(message.id));

    if (message.error) {
      pending.reject(new Error(`LSP error ${message.error.code}: ${message.error.message}`));
    } else {
      pending.resolve(message.result);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  dispose(): void {
    this.rejectAll(new Error('LSP client disposed'));
    this.process.kill();
  }
}
