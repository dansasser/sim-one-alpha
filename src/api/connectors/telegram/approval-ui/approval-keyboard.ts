import type { InlineKeyboardButton } from '../../../../api/connectors/telegram/telegram-api.js';

export const APPROVE_CALLBACK_PREFIX = 'approve:';
export const DENY_CALLBACK_PREFIX = 'deny:';

/**
 * Builds a single-row inline keyboard with Approve and Deny buttons.
 */
export function buildApprovalKeyboard(requestId: string): InlineKeyboardButton[][] {
  return [
    [
      { text: '✅ Approve', callback_data: `${APPROVE_CALLBACK_PREFIX}${requestId}` },
      { text: '❌ Deny', callback_data: `${DENY_CALLBACK_PREFIX}${requestId}` },
    ],
  ];
}
