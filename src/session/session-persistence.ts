import { sqlite } from '@flue/runtime/node';
import type {
  AgentExecutionStore,
  PersistenceAdapter,
  SessionData,
  SessionStore,
} from '@flue/runtime/adapter';
import type { GoromboConfig } from '../config/gorombo-config.js';
import {
  defaultSessionDatabasePath,
  GoromboSessionDatabase,
} from './session-database.js';
import { parseFlueSessionStorageKey } from './flue-session-store.js';

export const defaultFlueDatabasePath = '.gorombo/db/flue.sqlite';

export interface GoromboPersistenceRuntime {
  adapter: PersistenceAdapter;
  sessionDatabase: GoromboSessionDatabase;
  getLatestSessionData(harnessName: string, sessionName: string): Promise<SessionData | null>;
}

export function createGoromboPersistenceRuntime(config: GoromboConfig): GoromboPersistenceRuntime {
  const flueDatabasePath = config.storage?.flueDatabasePath ?? defaultFlueDatabasePath;
  const sessionDatabasePath = config.storage?.sessionDatabasePath ?? defaultSessionDatabasePath;
  const flueAdapter = sqlite(flueDatabasePath);
  const sessionDatabase = new GoromboSessionDatabase(sessionDatabasePath);
  let latestExecutionStore: AgentExecutionStore | undefined;

  const adapter: PersistenceAdapter = {
    async migrate() {
      await flueAdapter.migrate?.();
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
    async getLatestSessionData(harnessName, sessionName) {
      const storageKey = sessionDatabase.getLatestStorageKey(harnessName, sessionName);
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
    this.sessionDatabase.recordFlueSession(id, data);
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

    const latestStorageKey = this.sessionDatabase.getLatestStorageKey(parts.harnessName, parts.sessionName);
    await this.flueSessions.delete(id);
    this.sessionDatabase.deleteFlueSession(id);

    if (latestStorageKey && latestStorageKey !== id) {
      await this.flueSessions.delete(latestStorageKey);
      this.sessionDatabase.deleteFlueSession(latestStorageKey);
    }
  }
}
