import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function which(command: string): Promise<string | undefined> {
  try {
    if (process.platform === 'win32') {
      const result = await execFileAsync('cmd', ['/c', 'where', command]);
      return result.stdout.trim().split(/\r?\n/)[0] || undefined;
    }
    const result = await execFileAsync('command', ['-v', command]);
    return result.stdout.trim().split(/\r?\n/)[0] || undefined;
  } catch {
    return undefined;
  }
}

export interface LanguageServerCommand {
  languageId: string;
  fileExtensions: string[];
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface LspServerRegistryOptions {
  overrides?: Partial<Record<string, LanguageServerCommand>>;
}

export class LspLanguageServerRegistry {
  private readonly overrides: Partial<Record<string, LanguageServerCommand>>;

  constructor(options: LspServerRegistryOptions = {}) {
    this.overrides = options.overrides ?? {};
  }

  async resolve(languageId: string): Promise<LanguageServerCommand | undefined> {
    const override = this.overrides[languageId];
    if (override) {
      return override;
    }

    const defaults = defaultServerCommands[languageId];
    if (!defaults) {
      return undefined;
    }

    const command = await which(defaults.command);
    if (!command) {
      return undefined;
    }

    return { ...defaults, command };
  }

  resolveByFileExtension(extension: string): Promise<LanguageServerCommand | undefined> {
    const languageId = extensionToLanguageId(extension);
    return languageId ? this.resolve(languageId) : Promise.resolve(undefined);
  }

  listSupportedLanguages(): string[] {
    return Object.keys(defaultServerCommands);
  }
}

export function fileExtensionToLanguageId(extension: string): string | undefined {
  return extensionToLanguageId(extension);
}

const extensionToLanguageId = (extension: string): string | undefined => {
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.astro': 'astro',
    '.py': 'python',
  };
  return map[extension.toLowerCase()];
};

const defaultServerCommands: Record<string, LanguageServerCommand> = {
  typescript: {
    languageId: 'typescript',
    fileExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    command: 'typescript-language-server',
    args: ['--stdio'],
    env: {
      TSSERVER_LOG_FILE: '',
    },
  },
  javascript: {
    languageId: 'javascript',
    fileExtensions: ['.js', '.jsx', '.mjs', '.cjs'],
    command: 'typescript-language-server',
    args: ['--stdio'],
    env: {
      TSSERVER_LOG_FILE: '',
    },
  },
  astro: {
    languageId: 'astro',
    fileExtensions: ['.astro'],
    command: 'astro-ls',
    args: ['--stdio'],
  },
  python: {
    languageId: 'python',
    fileExtensions: ['.py'],
    command: 'pylsp',
    args: ['--stdio'],
  },
};
