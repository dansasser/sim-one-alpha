export interface TelegramConnectorState {
  enabled: boolean;
  pollerRunning: boolean;
  pollerStartedAt?: string;
  lastUpdateReceivedAt?: string;
  updateCount: number;
  errorCount: number;
  lastError?: string;
}

export const telegramConnectorState: TelegramConnectorState = {
  enabled: false,
  pollerRunning: false,
  updateCount: 0,
  errorCount: 0,
};

export function markTelegramUpdateReceived(): void {
  telegramConnectorState.lastUpdateReceivedAt = new Date().toISOString();
  telegramConnectorState.updateCount += 1;
}

export function markTelegramPollerStart(): void {
  telegramConnectorState.enabled = true;
  telegramConnectorState.pollerRunning = true;
  telegramConnectorState.pollerStartedAt = new Date().toISOString();
}

export function markTelegramPollerStop(): void {
  telegramConnectorState.pollerRunning = false;
}

export function markTelegramPollerError(error: unknown): void {
  telegramConnectorState.errorCount += 1;
  telegramConnectorState.lastError = error instanceof Error ? error.message : String(error);
}
