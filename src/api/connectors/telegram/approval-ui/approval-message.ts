import type { CodingApprovalRecord } from '../../../../engine/workers/coding-worker/approvals/approval-types.js';

export interface ApprovalMessageOptions {
  includeMetadata?: boolean;
}

/**
 * Builds the MarkdownV2 text for a pending approval prompt.
 */
export function buildApprovalRequestMessage(
  record: CodingApprovalRecord,
  options: ApprovalMessageOptions = {},
): string {
  const request = record.request;
  const lines: string[] = [
    '*Approval requested*',
    '',
    `*Action:* ${escapeMarkdown(request.actionType)}`,
    `*Summary:* ${escapeMarkdown(request.summary)}`,
  ];

  if (request.target) {
    lines.push(`*Target:* ${escapeMarkdown(request.target)}`);
  }

  lines.push(`*Risk:* ${escapeMarkdown(request.risk)}`);

  if (options.includeMetadata !== false) {
    lines.push('', `*Request ID:* \`${escapeMarkdown(request.id)}\``);
  }

  return lines.join('\n');
}

/**
 * Builds the MarkdownV2 text shown after an approval decision is recorded.
 */
export function buildApprovalResolvedMessage(record: CodingApprovalRecord): string {
  const decision = record.decision;
  const request = record.request;
  const statusLabel = record.status === 'approved' ? 'approved' : 'denied';
  const lines: string[] = [
    `*Approval ${statusLabel}*`,
    '',
    `*Action:* ${escapeMarkdown(request.actionType)}`,
    `*Summary:* ${escapeMarkdown(request.summary)}`,
  ];

  if (decision) {
    lines.push(`*Decided by:* ${escapeMarkdown(decision.decidedBy)}`);
    if (decision.reason) {
      lines.push(`*Reason:* ${escapeMarkdown(decision.reason)}`);
    }
  }

  return lines.join('\n');
}

/**
 * Escapes characters that Telegram MarkdownV2 treats as formatting.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}
