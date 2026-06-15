import { sqlite } from '@flue/runtime/node';
import type {
  AgentExecutionStore,
  PersistenceAdapter,
  SessionData,
  SessionStore,
} from '@flue/runtime/adapter';
import type { GoromboConfig } from '../config/gorombo-config.js';
import { createEmbeddingClient } from '../rag/embeddings.js';
import { runBackgroundIndexing } from '../rag/indexers/background-indexer.js';
import { LanceDbVectorStore } from '../rag/vector/index.js';
import {
  defaultSessionDatabasePath,
  GoromboSessionDatabase,
} from './session-database.js';
import { directAgentHarnessName, directAgentSessionName } from './direct-agent-session.js';
import {
  parseFlueSessionStorageKey,
  type FlueSessionStorageParts,
} from './flue-session-store.js';

export const defaultFlueDatabasePath = '.gorombo/db/flue.sqlite';

export interface GoromboPersistenceRuntime {
  adapter: PersistenceAdapter;
  sessionDatabase: GoromboSessionDatabase;
  vectorStore: LanceDbVectorStore;
  embeddingClient: ReturnType<typeof createEmbeddingClient>;
  getLatestSessionData(harnessName: string, sessionName: string): Promise<SessionData | null>;
  getLatestSessionDataForInstance(
    instanceId: string,
    harnessName: string,
    sessionName: string,
  ): Promise<SessionData | null>;
}

export function createGoromboPersistenceRuntime(config: GoromboConfig): GoromboPersistenceRuntime {
  const flueDatabasePath = config.storage?.flueDatabasePath ?? defaultFlueDatabasePath;
  const sessionDatabasePath = config.storage?.sessionDatabasePath ?? defaultSessionDatabasePath;
  const vectorStorePath = config.storage?.vectorStorePath;
  const flueAdapter = sqlite(flueDatabasePath);
  const vectorStore = new LanceDbVectorStore({ path: vectorStorePath });
  const embeddingClient = createEmbeddingClient();
  const sessionDatabase = new GoromboSessionDatabase(sessionDatabasePath, { vectorStore, embeddingClient });

  // Index project files and knowledge docs in the background so startup is not blocked.
  runBackgroundIndexing({ vectorStore, embeddingClient }).catch((error) =>
    console.error('[WARN] Background vector indexing failed:', error instanceof Error ? error.message : String(error)),
  );
  let latestExecutionStore: AgentExecutionStore | undefined;

  const adapter: PersistenceAdapter = {
    async migrate() {
      await flueAdapter.migrate?.();
      sessionDatabase.migrate();
    },
    connect() {
      const executionStore = flueAdapter.connect();
      latestExecutionStore = executionStore;
      return {
        ...executionStore,
        sessions: new GoromboLogicalSessionStore(executionStore.sessions, sessionDatabase),
      };
    },
    connectRunStore() {
      return flueAdapter.connectRunStore();
    },
    connectRunRegistry() {
      return flueAdapter.connectRunRegistry();
    },
    connectEventStreamStore() {
      return flueAdapter.connectEventStreamStore();
    },
    async close() {
      await flueAdapter.close?.();
      sessionDatabase.close();
    },
  };

  return {
    adapter,
    sessionDatabase,
    vectorStore,
    embeddingClient,
    async getLatestSessionData(harnessName, sessionName) {
      const storageKey = sessionDatabase.getLatestStorageKey(harnessName, sessionName);
      if (!storageKey) {
        return null;
      }

      const sessions = latestExecutionStore?.sessions ?? adapter.connect().sessions;
      return sessions.load(storageKey);
    },
    async getLatestSessionDataForInstance(instanceId, harnessName, sessionName) {
      const storageKey = sessionDatabase.getLatestStorageKeyForInstance(instanceId, harnessName, sessionName);
      if (!storageKey) {
        return null;
      }

      const sessions = latestExecutionStore?.sessions ?? adapter.connect().sessions;
      return sessions.load(storageKey);
    },
  };
}

class GoromboLogicalSessionStore implements SessionStore {
  constructor(
    private readonly flueSessions: SessionStore,
    private readonly sessionDatabase: GoromboSessionDatabase,
  ) {}

  async save(id: string, data: SessionData): Promise<void> {
    await this.flueSessions.save(id, data);
    await this.sessionDatabase.recordFlueSession(id, data);
  }

  async load(id: string): Promise<SessionData | null> {
    const exact = await this.flueSessions.load(id);
    if (exact) {
      return exact;
    }

    const parts = parseFlueSessionStorageKey(id);
    if (!parts) {
      return null;
    }

    const latestInstanceStorageKey = this.sessionDatabase.getLatestStorageKeyForInstance(
      parts.instanceId,
      parts.harnessName,
      parts.sessionName,
    );
    if (latestInstanceStorageKey && latestInstanceStorageKey !== id) {
      return this.flueSessions.load(latestInstanceStorageKey);
    }

    if (isDirectAgentStorageKey(parts)) {
      return null;
    }

    const latestStorageKey = this.sessionDatabase.getLatestStorageKey(parts.harnessName, parts.sessionName);
    if (!latestStorageKey || latestStorageKey === id) {
      return null;
    }

    return this.flueSessions.load(latestStorageKey);
  }

  async delete(id: string): Promise<void> {
    const parts = parseFlueSessionStorageKey(id);
    if (!parts) {
      await this.flueSessions.delete(id);
      return;
    }

    const exact = await this.flueSessions.load(id);
    await this.flueSessions.delete(id);
    this.sessionDatabase.deleteFlueSession(id);

    if (exact) {
      return;
    }

    const latestInstanceStorageKey = this.sessionDatabase.getLatestStorageKeyForInstance(
      parts.instanceId,
      parts.harnessName,
      parts.sessionName,
    );
    if (latestInstanceStorageKey && latestInstanceStorageKey !== id) {
      await this.flueSessions.delete(latestInstanceStorageKey);
      this.sessionDatabase.deleteFlueSession(latestInstanceStorageKey);
      return;
    }

    if (isDirectAgentStorageKey(parts)) {
      return;
    }

    const latestStorageKey = this.sessionDatabase.getLatestStorageKey(parts.harnessName, parts.sessionName);
    if (latestStorageKey && latestStorageKey !== id) {
      await this.flueSessions.delete(latestStorageKey);
      this.sessionDatabase.deleteFlueSession(latestStorageKey);
    }
  }
}

function isDirectAgentStorageKey(parts: FlueSessionStorageParts): boolean {
  return parts.harnessName === directAgentHarnessName && parts.sessionName === directAgentSessionName;
}
