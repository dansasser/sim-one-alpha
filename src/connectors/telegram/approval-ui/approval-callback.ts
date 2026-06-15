import { APPROVE_CALLBACK_PREFIX, DENY_CALLBACK_PREFIX } from './approval-keyboard.js';

export interface ParsedApprovalCallback {
  requestId: string;
  approved: boolean;
}

/**
 * Parses a Telegram callback payload shaped like `approve:<requestId>` or
 * `deny:<requestId>`. Returns undefined for unrecognized payloads.
 */
export function parseApprovalCallback(data: string): ParsedApprovalCallback | undefined {
  if (data.startsWith(APPROVE_CALLBACK_PREFIX)) {
    return {
      requestId: data.slice(APPROVE_CALLBACK_PREFIX.length),
      approved: true,
    };
  }
  if (data.startsWith(DENY_CALLBACK_PREFIX)) {
    return {
      requestId: data.slice(DENY_CALLBACK_PREFIX.length),
      approved: false,
    };
  }
  return undefined;
}
